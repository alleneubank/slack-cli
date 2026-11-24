import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'

import { z } from '@alleneubank/incur'

import { credentialsFailure, nonEmpty } from './auth.js'
import type { CredentialStore, CredentialsFile, TeamCredentials } from './credentials.js'
import type { Outcome } from './errors.js'
import {
  authorizeSlackUser,
  oauthScopes,
  parsePastedCode,
  OAUTH_TIMEOUT_MS,
  listenForLoopbackCode,
  LoopbackPortInUseError,
  type CodeDelivery,
  type ReceiveCode,
} from './oauth.js'
import { parseClientId, SLACK_OAUTH_CLIENT_ID, slackApp, slackAppSchema } from './slack-app.js'

const execFileAsync = promisify(execFile)

/** Browser side of `slack login`. */
export type OauthHost = {
  openUrl: (url: string) => Promise<void>
  /** Listens for the code the redirect page forwards to the loopback listener. */
  receiveCode: ReceiveCode
  /** Reads the code the user pastes from the redirect page (`slack login --paste`). */
  readPastedCode: (input: { timeoutMs: number }) => Promise<string>
  write?: (text: string) => void
  randomBytes?: (size: number) => Uint8Array
  timeoutMs?: number | undefined
}

export type LoginDeps = {
  store: CredentialStore
  fetch: (request: Request) => Response | Promise<Response>
  now: () => number
  oauth?: OauthHost | undefined
}

type SignInOptions = { write: z.ZodDefault<z.ZodBoolean>; paste: z.ZodDefault<z.ZodBoolean> }

/** Options every command that signs a workspace in accepts. */
export const signInOptions: SignInOptions = {
  write: z
    .boolean()
    .default(false)
    .describe('Also request write scopes (messages, files, channels, ...)'),
  paste: z
    .boolean()
    .default(false)
    .describe(
      'Show the code in the browser and read it here, for a machine the browser cannot reach (SSH)',
    ),
}

type SignedInOutput = z.ZodObject<{
  ok: z.ZodLiteral<true>
  teamId: z.ZodString
  teamName: z.ZodOptional<z.ZodString>
  userId: z.ZodOptional<z.ZodString>
  clientId: z.ZodString
  app: typeof slackAppSchema
  scopes: z.ZodOptional<z.ZodArray<z.ZodString>>
}>

/** What a command that signs a workspace in reports. */
export const signedInOutput: SignedInOutput = z.object({
  ok: z.literal(true),
  teamId: z.string(),
  teamName: z.string().optional(),
  userId: z.string().optional(),
  clientId: z.string().describe('Client id of the Slack app the workspace signed in through'),
  app: slackAppSchema,
  scopes: z
    .array(z.string())
    .optional()
    .describe('Every user scope the token carries, including ones granted at earlier logins'),
})

type SignedIn = z.infer<typeof signedInOutput>

/** The Slack app a login signs in through, and the workspace Slack is asked to open. */
export type LoginTarget = {
  clientId: string
  /** What chose the app: a flag or variable, or the stored workspace it belongs to. Absent for the default. */
  origin?: { input: '--client-id' | 'SLACK_CLIENT_ID' } | { storedFor: string } | undefined
  /** Workspace named by `--workspace` or `SLACK_WORKSPACE`; Slack treats it as a hint. */
  team?: string | undefined
}

/**
 * Client id precedence: `--client-id`, `SLACK_CLIENT_ID`, the app stored for
 * the named or current workspace, then the shared app. Re-login therefore
 * keeps a workspace on its own app without a variable.
 */
export function loginTarget(
  flag: string | undefined,
  named: string | undefined,
  env: Record<string, string | undefined>,
  file: CredentialsFile,
): Outcome<LoginTarget> {
  const hint = named === undefined ? undefined : { team: named }
  const variable = nonEmpty(env['SLACK_CLIENT_ID'])
  const chosen =
    flag !== undefined
      ? { input: '--client-id' as const, value: flag }
      : variable !== undefined
        ? { input: 'SLACK_CLIENT_ID' as const, value: variable }
        : undefined
  if (chosen !== undefined) {
    const clientId = parseClientId(chosen.value)
    if (clientId === undefined)
      return {
        ok: false,
        error: {
          code: 'INVALID_ARGUMENT',
          message: `${chosen.input} must be a Slack app client id (1234567890.1234567890) or shared`,
        },
      }
    return { ok: true, value: { clientId, origin: { input: chosen.input }, ...hint } }
  }
  const teamId = named ?? file.currentTeamId
  const storedClientId = teamId === undefined ? undefined : file.teams[teamId]?.clientId
  if (teamId !== undefined && storedClientId !== undefined)
    return { ok: true, value: { clientId: storedClientId, origin: { storedFor: teamId }, ...hint } }
  return { ok: true, value: { clientId: SLACK_OAUTH_CLIENT_ID, ...hint } }
}

/** The line login prints before the authorize URL, naming the app it signs in through. */
export function appLine(target: LoginTarget, file: CredentialsFile): string {
  const app = slackApp(target.clientId) === 'shared' ? 'shared' : `own app ${target.clientId}`
  return `App: ${app}${originNote(target.origin, file)}\n`
}

function originNote(origin: LoginTarget['origin'], file: CredentialsFile): string {
  if (origin === undefined) return ''
  if ('input' in origin) return ` (from ${origin.input})`
  const teamName = file.teams[origin.storedFor]?.teamName
  return ` (stored for ${teamName === undefined ? origin.storedFor : `${origin.storedFor} ${teamName}`})`
}

/**
 * Runs browser consent through `target`'s app, then stores the workspace and
 * makes it current. Writes `announce` before the authorize URL.
 */
export async function signIn(
  deps: LoginDeps,
  target: LoginTarget,
  options: { write: boolean; paste: boolean; announce: string },
): Promise<Outcome<SignedIn>> {
  const { clientId, team: teamHint } = target
  const oauth = deps.oauth ?? defaultOauthHost()
  const write = oauth.write ?? ((text: string) => process.stdout.write(text))
  const delivery: CodeDelivery = options.paste ? 'paste' : 'loopback'
  write(options.announce)
  let issued: Awaited<ReturnType<typeof authorizeSlackUser>>
  try {
    issued = await authorizeSlackUser({
      clientId,
      ...(teamHint === undefined ? undefined : { team: teamHint }),
      fetch: deps.fetch,
      delivery,
      openUrl: oauth.openUrl,
      receiveCode:
        delivery === 'paste'
          ? async (input) => ({ code: () => oauth.readPastedCode(input), close: () => {} })
          : oauth.receiveCode,
      onAuthorizeUrl: (url) => {
        write(`Authorize Slack:\n${url}\n`)
      },
      ...(oauth.randomBytes ? { randomBytes: oauth.randomBytes } : undefined),
      timeoutMs: oauth.timeoutMs ?? OAUTH_TIMEOUT_MS,
      scope: oauthScopes(options.write),
    })
  } catch (error) {
    if (!(error instanceof LoopbackPortInUseError)) throw error
    return {
      ok: false,
      error: {
        code: 'LOGIN_IN_PROGRESS',
        message: `Port ${error.port} is in use, most likely by another slack login waiting for consent; finish or cancel it, or sign in with slack login --paste`,
      },
    }
  }
  const team: TeamCredentials = {
    accessToken: issued.accessToken,
    clientId,
    ...(issued.refreshToken === undefined ? undefined : { refreshToken: issued.refreshToken }),
    ...(issued.expiresIn === undefined
      ? undefined
      : { expiresAt: deps.now() + issued.expiresIn * 1000 }),
    ...(issued.userId === undefined ? undefined : { userId: issued.userId }),
    ...(issued.teamName === undefined ? undefined : { teamName: issued.teamName }),
    ...(issued.scopes === undefined ? undefined : { scopes: issued.scopes }),
  }
  let previousClientId: string | undefined
  try {
    previousClientId = await deps.store.withLock(async (locked) => {
      const file = await locked.read()
      await locked.write({
        version: 1,
        currentTeamId: issued.teamId,
        teams: { ...file.teams, [issued.teamId]: team },
      })
      return file.teams[issued.teamId]?.clientId
    })
  } catch (error) {
    return { ok: false, error: credentialsFailure(error) }
  }
  // Slack's consent page can switch workspaces, so the app change is reported, not assumed.
  if (previousClientId !== undefined && previousClientId !== clientId)
    write(
      `${issued.teamId} now signs in through ${appName(clientId)} instead of ${appName(previousClientId)}\n`,
    )
  return {
    ok: true,
    value: {
      ok: true,
      teamId: issued.teamId,
      ...(issued.teamName === undefined ? undefined : { teamName: issued.teamName }),
      ...(issued.userId === undefined ? undefined : { userId: issued.userId }),
      clientId,
      app: slackApp(clientId),
      ...(issued.scopes === undefined ? undefined : { scopes: issued.scopes }),
    },
  }
}

function appName(clientId: string): string {
  return slackApp(clientId) === 'shared' ? 'the shared app' : `own app ${clientId}`
}

function defaultOauthHost(): OauthHost {
  return {
    async openUrl(url) {
      if (process.platform === 'darwin') await execFileAsync('open', [url])
      else if (process.platform === 'win32') await execFileAsync('cmd', ['/c', 'start', '', url])
      else await execFileAsync('xdg-open', [url])
    },
    receiveCode: (input) => listenForLoopbackCode(input),
    async readPastedCode({ timeoutMs }) {
      const terminal = createInterface({ input: process.stdin, output: process.stderr })
      try {
        const pasted = await terminal.question('Paste the code shown in the browser: ', {
          signal: AbortSignal.timeout(timeoutMs),
        })
        return parsePastedCode(pasted)
      } finally {
        terminal.close()
      }
    },
  }
}
