import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { Cli, z } from '@alleneubank/incur'

import {
  credentialResolver,
  credentialsFailure,
  namedWorkspace,
  nonEmpty,
  readStore,
  selectedWorkspace,
  unknownWorkspace,
} from './auth.js'
import { commandError, type Outcome } from './errors.js'
import {
  fileCredentialStore,
  type CredentialStore,
  type CredentialsFile,
  type TeamCredentials,
} from './credentials.js'
import { fileCommands } from './files.js'
import { SLACK_METHOD_FAMILIES } from './methods.js'
import {
  authorizeSlackUser,
  oauthScopes,
  parsePastedCode,
  OAUTH_TIMEOUT_MS,
  waitForLoopbackCode,
  type CodeDelivery,
} from './oauth.js'
import { parseClientId, SLACK_OAUTH_CLIENT_ID, slackApp, slackAppSchema } from './slack-app.js'
import { SOURCE_URL, VERSION } from './version.js'
import { SLACK_API_ORIGIN, slackWebApiFamily, type WebApiDeps } from './web-api.js'
import { workspacesCli } from './workspaces.js'

const execFileAsync = promisify(execFile)

/** Browser side of `slack login`. */
export type OauthHost = {
  openUrl: (url: string) => Promise<void>
  /** Receives the code the redirect page forwards to the loopback listener. */
  waitForCode: (input: { state: string; timeoutMs: number }) => Promise<{ code: string }>
  /** Reads the code the user pastes from the redirect page (`slack login --paste`). */
  readPastedCode: (input: { timeoutMs: number }) => Promise<string>
  write?: (text: string) => void
  randomBytes?: (size: number) => Uint8Array
  timeoutMs?: number | undefined
}

export type CreateCliDeps = {
  version?: string | undefined
  env?: Record<string, string | undefined> | undefined
  credentials?: CredentialStore | undefined
  oauth?: OauthHost | undefined
  /** HTTP to slack.com: Web API methods and the OAuth token endpoint. */
  fetch?: ((request: Request) => Response | Promise<Response>) | undefined
  apiOrigin?: string | undefined
  now?: (() => number) | undefined
}

type Globals = z.ZodObject<{ workspace: z.ZodOptional<z.ZodString> }>

const globals: Globals = z.object({
  workspace: z
    .string()
    .optional()
    .describe('Team id of a stored workspace (default: SLACK_WORKSPACE, then the current one)'),
})

type Environment = z.ZodObject<{
  SLACK_TOKEN: z.ZodOptional<z.ZodString>
  SLACK_WORKSPACE: z.ZodOptional<z.ZodString>
  SLACK_CLIENT_ID: z.ZodOptional<z.ZodString>
}>

/** Documents the environment in help; values are read from `CreateCliDeps.env`. */
const environment: Environment = z.object({
  SLACK_TOKEN: z
    .string()
    .optional()
    .describe('Slack user token; overrides every stored workspace and is never refreshed')
    .meta({ secret: true }),
  SLACK_WORKSPACE: z
    .string()
    .optional()
    .describe('Team id of the stored workspace to use when --workspace is absent'),
  SLACK_CLIENT_ID: z
    .string()
    .optional()
    .describe(
      'Client id of the Slack app slack login uses, or shared; overrides the stored workspace app',
    ),
})

/** Directory holding `skills/`, from `src/` in development and `dist/` when installed. */
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

/** Unofficial Slack CLI. Commands are typed Slack Web API methods from the generated catalog. */
export function createCli(deps: CreateCliDeps = {}): Cli.Cli<{}, undefined, Environment, Globals> {
  const env = deps.env ?? process.env
  const store = deps.credentials ?? fileCredentialStore()
  const fetch = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const now = deps.now ?? Date.now

  const cli = Cli.create('slack', {
    version: deps.version ?? VERSION,
    description: `Unofficial Slack CLI, not affiliated with Slack (${SOURCE_URL}). Commands are typed Slack Web API methods. Agents: \`slack <family> --llms-full\` prints one family's schemas; \`slack workspaces list\` shows stored logins.`,
    package: '@alleneubank/slack-cli',
    // One hand-written skill replaces the generated one: generated skill files
    // cover every method and run to hundreds of kilobytes.
    sync: {
      depth: 0,
      include: ['skills/slack'],
      cwd: packageRoot,
      body: 'Authorize a workspace first: slack login',
    },
    mcp: false,
    // No background update checks: the CLI talks only to slack.com unless the
    // user runs `slack --update`.
    update: false,
    globals,
    env: environment,
  })
    .command('login', {
      description: 'Authorize a Slack workspace in the browser and make it current',
      options: z.object({
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
        clientId: z
          .string()
          .optional()
          .describe(
            'Client id of the Slack app to sign in through, or shared for this CLI app (default: SLACK_CLIENT_ID, then the app the workspace last used)',
          ),
      }),
      output: z.object({
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
      }),
      async run(context) {
        const stored = await readStore(store)
        if (!stored.ok) return context.error(commandError(stored.error))
        const target = loginTarget(
          context.options.clientId,
          namedWorkspace(context.globals.workspace, env),
          env,
          stored.value,
        )
        if (!target.ok) return context.error(commandError(target.error))
        const { clientId, team: teamHint } = target.value
        const oauth = deps.oauth ?? defaultOauthHost()
        const write = oauth.write ?? ((text: string) => process.stdout.write(text))
        const delivery: CodeDelivery = context.options.paste ? 'paste' : 'loopback'
        write(appLine(target.value, stored.value))
        const issued = await authorizeSlackUser({
          clientId,
          ...(teamHint === undefined ? undefined : { team: teamHint }),
          fetch,
          delivery,
          openUrl: oauth.openUrl,
          waitForCode:
            delivery === 'paste'
              ? async (input) => ({ code: await oauth.readPastedCode(input) })
              : oauth.waitForCode,
          onAuthorizeUrl: (url) => {
            write(`Authorize Slack:\n${url}\n`)
          },
          ...(oauth.randomBytes ? { randomBytes: oauth.randomBytes } : undefined),
          timeoutMs: oauth.timeoutMs ?? OAUTH_TIMEOUT_MS,
          scope: oauthScopes(context.options.write),
        })
        const team: TeamCredentials = {
          accessToken: issued.accessToken,
          clientId,
          ...(issued.refreshToken === undefined
            ? undefined
            : { refreshToken: issued.refreshToken }),
          ...(issued.expiresIn === undefined
            ? undefined
            : { expiresAt: now() + issued.expiresIn * 1000 }),
          ...(issued.userId === undefined ? undefined : { userId: issued.userId }),
          ...(issued.teamName === undefined ? undefined : { teamName: issued.teamName }),
          ...(issued.scopes === undefined ? undefined : { scopes: issued.scopes }),
        }
        let previousClientId: string | undefined
        try {
          previousClientId = await store.withLock(async (locked) => {
            const file = await locked.read()
            await locked.write({
              version: 1,
              currentTeamId: issued.teamId,
              teams: { ...file.teams, [issued.teamId]: team },
            })
            return file.teams[issued.teamId]?.clientId
          })
        } catch (error) {
          return context.error(commandError(credentialsFailure(error)))
        }
        // Slack's consent page can switch workspaces, so the app change is reported, not assumed.
        if (previousClientId !== undefined && previousClientId !== clientId)
          write(
            `${issued.teamId} now signs in through ${appName(clientId)} instead of ${appName(previousClientId)}\n`,
          )
        return {
          ok: true as const,
          teamId: issued.teamId,
          ...(issued.teamName === undefined ? undefined : { teamName: issued.teamName }),
          ...(issued.userId === undefined ? undefined : { userId: issued.userId }),
          clientId,
          app: slackApp(clientId),
          ...(issued.scopes === undefined ? undefined : { scopes: issued.scopes }),
        }
      },
    })
    .command('logout', {
      description: 'Remove the selected workspace, or every workspace with --all',
      options: z.object({
        all: z.boolean().default(false).describe('Remove every stored workspace'),
      }),
      output: z.object({
        ok: z.literal(true),
        removed: z.array(z.string()),
        currentTeamId: z.string().optional(),
      }),
      async run(context) {
        try {
          return await store.withLock(async (locked) => {
            if (context.options.all) {
              // An unreadable file is still removed; that is the documented way out of it.
              const stored = await readStore(locked)
              await locked.clear()
              const removed = stored.ok ? Object.keys(stored.value.teams) : []
              return { ok: true as const, removed }
            }
            const file = await locked.read()
            const teamId = selectedWorkspace(context.globals.workspace, env, file)
            if (teamId === undefined) return { ok: true as const, removed: [] }
            if (file.teams[teamId] === undefined)
              return context.error(commandError(unknownWorkspace(teamId, file)))
            const { [teamId]: _removed, ...teams } = file.teams
            const remaining = Object.keys(teams).toSorted()
            if (remaining.length === 0) {
              await locked.clear()
              return { ok: true as const, removed: [teamId] }
            }
            const currentTeamId =
              file.currentTeamId !== undefined && file.currentTeamId !== teamId
                ? file.currentTeamId
                : remaining[0]!
            await locked.write({ version: 1, currentTeamId, teams })
            return { ok: true as const, removed: [teamId], currentTeamId }
          })
        } catch (error) {
          return context.error(commandError(credentialsFailure(error)))
        }
      },
    })
    .command(workspacesCli({ store, env }))

  // Entries stored before login recorded a client id were issued by SLACK_CLIENT_ID's app or the shared one.
  const variable = nonEmpty(env['SLACK_CLIENT_ID'])
  const unrecordedClientId =
    (variable === undefined ? undefined : parseClientId(variable)) ?? SLACK_OAUTH_CLIENT_ID
  const credential = credentialResolver({ env, store, fetch, now, clientId: unrecordedClientId })
  const webApi: WebApiDeps = { fetch, credential, origin: deps.apiOrigin ?? SLACK_API_ORIGIN }
  for (const family of SLACK_METHOD_FAMILIES)
    cli.plugin(
      family,
      slackWebApiFamily(family, webApi, family === 'files' ? fileCommands(webApi) : undefined),
    )
  return cli
}

/** The Slack app a login signs in through, and the workspace Slack is asked to open. */
type LoginTarget = {
  clientId: string
  /** The stored workspace whose app this is, when no flag or variable chose one. */
  storedFor?: string | undefined
  /** Workspace named by `--workspace` or `SLACK_WORKSPACE`; Slack treats it as a hint. */
  team?: string | undefined
}

/**
 * Client id precedence: `--client-id`, `SLACK_CLIENT_ID`, the app stored for
 * the named or current workspace, then the shared app. Re-login therefore
 * keeps a workspace on its own app without a variable.
 */
function loginTarget(
  flag: string | undefined,
  named: string | undefined,
  env: Record<string, string | undefined>,
  file: CredentialsFile,
): Outcome<LoginTarget> {
  const hint = named === undefined ? undefined : { team: named }
  const variable = nonEmpty(env['SLACK_CLIENT_ID'])
  const chosen =
    flag !== undefined
      ? { source: '--client-id', value: flag }
      : variable !== undefined
        ? { source: 'SLACK_CLIENT_ID', value: variable }
        : undefined
  if (chosen !== undefined) {
    const clientId = parseClientId(chosen.value)
    if (clientId === undefined)
      return {
        ok: false,
        error: {
          code: 'INVALID_ARGUMENT',
          message: `${chosen.source} must be a Slack app client id (1234567890.1234567890) or shared`,
        },
      }
    return { ok: true, value: { clientId, ...hint } }
  }
  const teamId = named ?? file.currentTeamId
  const storedClientId = teamId === undefined ? undefined : file.teams[teamId]?.clientId
  if (teamId !== undefined && storedClientId !== undefined)
    return { ok: true, value: { clientId: storedClientId, storedFor: teamId, ...hint } }
  return { ok: true, value: { clientId: SLACK_OAUTH_CLIENT_ID, ...hint } }
}

function appName(clientId: string): string {
  return slackApp(clientId) === 'shared' ? 'the shared app' : `own app ${clientId}`
}

function appLine(target: LoginTarget, file: CredentialsFile): string {
  if (slackApp(target.clientId) === 'shared') return 'App: shared\n'
  if (target.storedFor === undefined) return `App: own app ${target.clientId}\n`
  const teamName = file.teams[target.storedFor]?.teamName
  const workspace = teamName === undefined ? target.storedFor : `${target.storedFor} ${teamName}`
  return `App: own app ${target.clientId} (stored for ${workspace})\n`
}

function defaultOauthHost(): OauthHost {
  return {
    async openUrl(url) {
      if (process.platform === 'darwin') await execFileAsync('open', [url])
      else if (process.platform === 'win32') await execFileAsync('cmd', ['/c', 'start', '', url])
      else await execFileAsync('xdg-open', [url])
    },
    waitForCode: (input) => waitForLoopbackCode(input),
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
