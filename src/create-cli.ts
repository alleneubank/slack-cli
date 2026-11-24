import path from 'node:path'
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
import { appCli, type ConfigurationTokenReader } from './app.js'
import { commandError } from './errors.js'
import { fileCredentialStore, type CredentialStore } from './credentials.js'
import { fileCommands } from './files.js'
import {
  appLine,
  loginTarget,
  signedInOutput,
  signIn,
  signInOptions,
  type LoginDeps,
  type OauthHost,
} from './login.js'
import { SLACK_METHOD_FAMILIES } from './methods.js'
import { parseClientId, SLACK_OAUTH_CLIENT_ID } from './slack-app.js'
import { SOURCE_URL, VERSION } from './version.js'
import { SLACK_API_ORIGIN, slackWebApiFamily, type WebApiDeps } from './web-api.js'
import { workspacesCli } from './workspaces.js'

export type { OauthHost } from './login.js'

export type CreateCliDeps = {
  version?: string | undefined
  env?: Record<string, string | undefined> | undefined
  credentials?: CredentialStore | undefined
  oauth?: OauthHost | undefined
  /** HTTP to slack.com: Web API methods and the OAuth token endpoint. */
  fetch?: ((request: Request) => Response | Promise<Response>) | undefined
  apiOrigin?: string | undefined
  /** Reads the app configuration token for `slack app create`. */
  readConfigurationToken?: ConfigurationTokenReader | undefined
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
  const loginDeps: LoginDeps = { store, fetch, now, oauth: deps.oauth }

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
        ...signInOptions,
        clientId: z
          .string()
          .optional()
          .describe(
            'Client id of the Slack app to sign in through, or shared for this CLI app (default: SLACK_CLIENT_ID, then the app the workspace last used)',
          ),
      }),
      output: signedInOutput,
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
        const signedIn = await signIn(loginDeps, target.value, {
          write: context.options.write,
          paste: context.options.paste,
          announce: appLine(target.value, stored.value),
        })
        return signedIn.ok ? signedIn.value : context.error(commandError(signedIn.error))
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
    .command(
      appCli({
        ...loginDeps,
        env,
        origin: deps.apiOrigin ?? SLACK_API_ORIGIN,
        manifestPath: path.join(packageRoot, 'slack-app-manifest.json'),
        readConfigurationToken: deps.readConfigurationToken,
      }),
    )

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
