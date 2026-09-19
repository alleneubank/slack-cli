import { Cli, z, type Plugin } from '@alleneubank/incur'

import { commandError, type Outcome } from './errors.js'
import { familySummary, slackMethods, type SlackMethod } from './methods.js'

export const SLACK_API_ORIGIN: string = 'https://slack.com'
export const SLACK_API_TIMEOUT_MS: number = 30_000
/** Largest Slack response body accepted; a full page of 1000 messages with blocks fits well below it. */
export const SLACK_RESPONSE_BYTES_MAX: number = 16 * 1024 * 1024

const slackResponseSchema = z.object({ ok: z.boolean() }).passthrough()
const workspaceGlobals = z.object({ workspace: z.string().optional() })

/** A resolved access token. `refresh` renews a stored rotating token; absent for `SLACK_TOKEN`. */
export type Credential = {
  token: string
  refresh?: (() => Promise<Outcome<string>>) | undefined
}

export type WebApiDeps = {
  fetch: (request: Request) => Response | Promise<Response>
  /** Resolves the token for the workspace named by `--workspace`, if any. */
  credential: (workspace: string | undefined) => Promise<Outcome<Credential>>
  origin: string
  timeoutMs?: number | undefined
}

/** A successful Slack Web API response body. */
type SlackBody = { ok: true; [key: string]: unknown }

type Group = { methods: SlackMethod[]; groups: Map<string, Group> }

/** Mounts one Slack method family, e.g. `conversations`, as `slack conversations <method>`. */
export function slackWebApiFamily(family: string, deps: WebApiDeps): Plugin {
  const description = familySummary(family)
  return {
    name: `slack-web-api-${family}`,
    description,
    async resolve({ mount }) {
      const root: Group = { methods: [], groups: new Map() }
      for (const method of slackMethods(family)) {
        let group = root
        for (const segment of method.path.slice(0, -1)) group = childGroup(group, segment)
        group.methods.push(method)
      }
      return groupCli(mount, description, [family], root, deps)
    },
  }
}

function childGroup(group: Group, segment: string): Group {
  const existing = group.groups.get(segment)
  if (existing !== undefined) return existing
  const created: Group = { methods: [], groups: new Map() }
  group.groups.set(segment, created)
  return created
}

function groupCli(
  name: string,
  description: string,
  prefix: string[],
  group: Group,
  deps: WebApiDeps,
): Cli.Cli {
  const cli = Cli.create(name, { description })
  for (const method of group.methods) {
    cli.command(method.path.at(-1)!, {
      description: method.summary,
      hint: method.hint,
      args: method.args,
      options: method.options,
      output: slackResponseSchema,
      mutates: method.mutates,
      destructive: method.destructive,
      async run(context) {
        const { workspace } = workspaceGlobals.parse(context.globals)
        const input = { ...context.args, ...context.options }
        const outcome = await invoke(method, input, workspace, deps)
        return outcome.ok ? outcome.value : context.error(commandError(outcome.error))
      },
    })
  }
  for (const [segment, child] of group.groups) {
    const path = [...prefix, segment]
    cli.command(groupCli(segment, `Slack ${path.join('.')}.* methods`, path, child, deps))
  }
  return cli
}

async function invoke(
  method: SlackMethod,
  input: Record<string, unknown>,
  workspace: string | undefined,
  deps: WebApiDeps,
): Promise<Outcome<SlackBody>> {
  const resolved = await deps.credential(workspace)
  if (!resolved.ok) return resolved
  const body = formBody(method, input)
  const first = await post(method, body, resolved.value.token, deps)
  const expired = !first.ok && first.error.code === 'token_expired'
  if (!expired || resolved.value.refresh === undefined) return first
  const refreshed = await resolved.value.refresh()
  if (!refreshed.ok) return refreshed
  return post(method, body, refreshed.value, deps)
}

/** Only the method's declared Slack arguments are sent. */
function formBody(method: SlackMethod, input: Record<string, unknown>): URLSearchParams {
  const body = new URLSearchParams()
  for (const [key, parameter] of method.parameters) {
    const value = input[key]
    if (value !== undefined) body.append(parameter, String(value))
  }
  return body
}

/** Slack rejected the call before acting on it. */
const retryableSlackErrors = new Set(['ratelimited', 'request_timeout'])
/** Slack failed while handling the call; Slack says part of it may have succeeded. */
const uncertainSlackErrors = new Set(['fatal_error', 'internal_error', 'service_unavailable'])

async function post(
  method: SlackMethod,
  body: URLSearchParams,
  token: string,
  deps: WebApiDeps,
): Promise<Outcome<SlackBody>> {
  const timeoutMs = deps.timeoutMs ?? SLACK_API_TIMEOUT_MS
  let response: Response
  try {
    response = await deps.fetch(
      new Request(`${deps.origin}/api/${method.name}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      }),
    )
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    return uncertain(
      method,
      timedOut ? 'TIMEOUT' : 'NETWORK',
      timedOut
        ? `Slack Web API timed out after ${timeoutMs}ms`
        : `Slack Web API request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after')
      return failure(
        'RATE_LIMITED',
        `Slack rate limited ${method.name}${retryAfter === null ? '' : `; retry after ${retryAfter}s`}`,
        true,
      )
    }
    const message = `Slack Web API returned HTTP ${response.status}`
    return response.status >= 500
      ? uncertain(method, 'HTTP_ERROR', message)
      : failure('HTTP_ERROR', message)
  }

  const text = await readBounded(response, SLACK_RESPONSE_BYTES_MAX)
  if (text === undefined)
    return failure('BAD_RESPONSE', `Slack response exceeded ${SLACK_RESPONSE_BYTES_MAX} bytes`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return failure('BAD_RESPONSE', 'Slack response is not JSON')
  }
  if (!isRecord(parsed)) return failure('BAD_RESPONSE', 'Slack response is not a JSON object')
  if (!isSuccess(parsed)) {
    const code = typeof parsed['error'] === 'string' ? parsed['error'] : 'unknown_error'
    const message = slackErrorMessage(method.name, code, parsed)
    if (retryableSlackErrors.has(code)) return failure(code, message, true)
    if (uncertainSlackErrors.has(code)) return uncertain(method, code, message)
    if (code === 'missing_scope' && typeof parsed['needed'] === 'string')
      return { ok: false, error: { code, message, neededScopes: parsed['needed'].split(',') } }
    return failure(code, message)
  }
  return { ok: true, value: parsed }
}

/** Reads the body, or returns undefined once it exceeds `bytesMax`. */
async function readBounded(response: Response, bytesMax: number): Promise<string | undefined> {
  if (Number(response.headers.get('content-length')) > bytesMax) {
    await response.body?.cancel()
    return undefined
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > bytesMax) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** Slack's error code plus the detail Slack returns for scope and argument errors. */
function slackErrorMessage(
  methodName: string,
  code: string,
  body: Record<string, unknown>,
): string {
  const details: string[] = []
  if (typeof body['needed'] === 'string') details.push(`needed scope: ${body['needed']}`)
  const metadata = body['response_metadata']
  if (isRecord(metadata) && Array.isArray(metadata['messages']))
    details.push(...metadata['messages'].filter((item) => typeof item === 'string'))
  const suffix = details.length > 0 ? ` (${details.join('; ')})` : ''
  return `Slack Web API ${methodName} failed: ${code}${suffix}`
}

/** A read can be retried; a write may already have taken effect, so retrying could repeat it. */
function uncertain(method: SlackMethod, code: string, message: string): Outcome<never> {
  return method.mutates
    ? failure(code, `${message}; the write may have been applied, so check before retrying`)
    : failure(code, message, true)
}

function failure(code: string, message: string, retryable?: boolean): Outcome<never> {
  return { ok: false, error: { code, message, ...(retryable ? { retryable } : undefined) } }
}

function isSuccess(body: Record<string, unknown>): body is SlackBody {
  return body['ok'] === true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
