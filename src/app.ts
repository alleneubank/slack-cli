import { readFile } from 'node:fs/promises'

import { Cli, z } from '@alleneubank/incur'

import { readStore, selectedWorkspace, unknownWorkspace } from './auth.js'
import { commandError, type CommandError, type Failure, type Outcome } from './errors.js'
import { signedInOutput, signIn, signInOptions, type LoginDeps } from './login.js'
import { OAUTH_TIMEOUT_MS, OAUTH_WRITE_SCOPES } from './oauth.js'
import { CLIENT_ID_PATTERN, slackApp } from './slack-app.js'
import { callSlackMethod, type WebApiDeps } from './web-api.js'

/**
 * Reads an app configuration token: from a hidden prompt on a terminal, or
 * from stdin when it is piped. Returns what was entered, untrimmed.
 */
export type ConfigurationTokenReader = (input: {
  prompt: string
  timeoutMs: number
}) => Promise<string>

export type AppDeps = LoginDeps & {
  env: Record<string, string | undefined>
  origin: string
  /** `slack-app-manifest.json`: the app `slack app create` makes. */
  manifestPath: string
  readConfigurationToken?: ConfigurationTokenReader | undefined
}

const configurationTokenPattern = /^xoxe\.xoxp-[A-Za-z0-9-]{1,500}$/
/** Longer than any configuration token; input past it fails the shape check. */
const configurationTokenCharsMax = 600

const configurationTokenPrompt =
  'Generate an app configuration token at https://api.slack.com/apps\n' +
  '(Your App Configuration Tokens → Generate Token, choose the workspace),\n' +
  'then paste its access token.\n' +
  'Configuration token: '

/** The parts of `apps.manifest.create`'s answer the CLI keeps; the app's secrets are dropped. */
const createdAppSchema = z.object({
  app_id: z.string().min(1),
  credentials: z.object({ client_id: z.string().regex(CLIENT_ID_PATTERN) }),
})

/** `slack app`: the workspace's own Slack app. */
export function appCli(deps: AppDeps): Cli.Cli {
  return Cli.create('app', {
    description:
      "Create or update the workspace's own Slack app, which Slack does not rate-limit like the shared app",
  })
    .command('create', {
      description:
        'Create a Slack app from the bundled manifest in the workspace of an app configuration token, read from a hidden prompt or stdin, then sign in through it',
      options: z.object(signInOptions),
      output: signedInOutput.extend({ appId: z.string().describe('Id of the created Slack app') }),
      mutates: true,
      async run(context) {
        const write = writer(deps)
        const token = await readToken(deps)
        if (!token.ok) return context.error(commandError(token.error))

        const manifest = await readFile(deps.manifestPath, 'utf8')
        const created = await callSlackMethod(
          'apps.manifest.create',
          { manifest },
          undefined,
          configured(deps, token.value),
        )
        const finishInstead = `If https://api.slack.com/apps lists the new app, finish with slack ${loginCommand('<its Client ID>', context.options)} instead of creating another`
        if (!created.ok)
          return context.error(
            commandError(
              created.error.mayHaveApplied === true
                ? { ...created.error, message: `${created.error.message}. ${finishInstead}` }
                : created.error,
            ),
          )
        const app = createdAppSchema.safeParse(created.value)
        if (!app.success)
          return context.error(
            commandError({
              code: 'BAD_RESPONSE',
              message: `Slack answered apps.manifest.create without an app id and client id. ${finishInstead}`,
            }),
          )
        const appId = app.data.app_id
        const clientId = app.data.credentials.client_id
        write(`Created app ${appId} (client id ${clientId}).\n`)

        const options = { write: context.options.write, paste: context.options.paste }
        let signedIn: Awaited<ReturnType<typeof signIn>>
        try {
          signedIn = await signIn(
            deps,
            { clientId },
            { ...options, announce: `App: own app ${clientId}\n`, appId },
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return context.error(
            notSignedIn(appId, clientId, options, { code: 'SIGN_IN_FAILED', message }),
          )
        }
        if (!signedIn.ok)
          return context.error(notSignedIn(appId, clientId, options, signedIn.error))
        write(
          'If this workspace also signed in through the shared app, it stays authorized there; remove it under Manage apps in Slack.\n',
        )
        return { ...signedIn.value, appId }
      },
    })
    .command('update', {
      description:
        "Add the user scopes and redirect this release's slack login needs to the workspace's own Slack app, with an app configuration token read from a hidden prompt or stdin",
      hint: 'Updates only oauth_config; the app keeps its name, icon, and any scopes it has beyond these. Running it again changes nothing.',
      options: z.object({
        app: z
          .string()
          .regex(APP_ID_PATTERN)
          .optional()
          .describe(
            'App id (A…) to update. Default: the app slack app create stored for the workspace',
          ),
      }),
      output: z.object({
        ok: z.literal(true),
        appId: z.string(),
        changed: z.boolean().describe('Whether the app was updated; false when it already matched'),
        addedScopes: z.array(z.string()).describe('User scopes added to the app'),
      }),
      mutates: true,
      async run(context) {
        const { workspace } = workspaceGlobals.parse(context.globals)
        const appId = await updateTarget(deps, context.options.app, workspace)
        if (!appId.ok) return context.error(commandError(appId.error))
        const token = await readToken(deps)
        if (!token.ok) return context.error(commandError(token.error))
        const slack = configured(deps, token.value)

        const exported = await callSlackMethod(
          'apps.manifest.export',
          { app_id: appId.value },
          undefined,
          slack,
        )
        if (!exported.ok) return context.error(commandError(exported.error))
        const current = exportedSchema.safeParse(exported.value)
        if (!current.success)
          return context.error(
            commandError({
              code: 'BAD_RESPONSE',
              message: `Slack answered apps.manifest.export for ${appId.value} without a manifest`,
            }),
          )
        const bundled = bundledSchema.parse(JSON.parse(await readFile(deps.manifestPath, 'utf8')))
        const plan = scopePlan(current.data.manifest, bundled)
        const write = writer(deps)
        if (plan.manifest === undefined) {
          write(`App ${appId.value} already has what slack login needs.\n`)
          return { ok: true as const, appId: appId.value, changed: false, addedScopes: [] }
        }

        const updated = await callSlackMethod(
          'apps.manifest.update',
          { app_id: appId.value, manifest: JSON.stringify(plan.manifest) },
          undefined,
          slack,
        )
        if (!updated.ok)
          return context.error(
            commandError(
              updated.error.mayHaveApplied === true
                ? {
                    ...updated.error,
                    message: `${updated.error.message}. Running slack app update again is safe: it changes nothing once the app matches`,
                  }
                : updated.error,
            ),
          )
        const writeScopes = plan.addedScopes.some((scope) => OAUTH_WRITE_SCOPES.includes(scope))
        write(
          plan.addedScopes.length === 0
            ? `Updated app ${appId.value}'s redirect and PKCE settings.\n`
            : `Added ${plan.addedScopes.length} user scopes to app ${appId.value}: ${plan.addedScopes.join(', ')}\nRun slack login${writeScopes ? ' --write' : ''} to grant them.\n`,
        )
        return {
          ok: true as const,
          appId: appId.value,
          changed: true,
          addedScopes: plan.addedScopes,
        }
      },
    })
}

const APP_ID_PATTERN = /^A[A-Z0-9]{2,30}$/

const workspaceGlobals = z.object({ workspace: z.string().optional() })

/** The part of a manifest `slack app update` changes; the rest passes through untouched. */
const oauthConfigSchema = z
  .object({
    redirect_urls: z.array(z.string()).optional(),
    pkce_enabled: z.boolean().optional(),
    scopes: z
      .object({ user: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()

const exportedSchema = z.object({
  manifest: z.object({ oauth_config: oauthConfigSchema.optional() }).passthrough(),
})

const bundledSchema = z.object({
  oauth_config: z.object({
    redirect_urls: z.array(z.string()),
    pkce_enabled: z.boolean(),
    scopes: z.object({ user: z.array(z.string()) }),
  }),
})

type ExportedManifest = z.infer<typeof exportedSchema>['manifest']

/**
 * The manifest that gives `current` the bundled user scopes, redirect, and
 * PKCE setting, keeping everything else; `manifest` is undefined when nothing
 * would change.
 */
function scopePlan(
  current: ExportedManifest,
  bundled: z.infer<typeof bundledSchema>,
): { manifest: ExportedManifest | undefined; addedScopes: string[] } {
  const config = current.oauth_config ?? {}
  const userScopes = config.scopes?.user ?? []
  const redirects = config.redirect_urls ?? []
  const wanted = bundled.oauth_config
  const addedScopes = wanted.scopes.user.filter((scope) => !userScopes.includes(scope))
  const addedRedirects = wanted.redirect_urls.filter((url) => !redirects.includes(url))
  const pkceChanges = config.pkce_enabled !== wanted.pkce_enabled
  if (addedScopes.length === 0 && addedRedirects.length === 0 && !pkceChanges)
    return { manifest: undefined, addedScopes }
  return {
    addedScopes,
    manifest: {
      ...current,
      oauth_config: {
        ...config,
        redirect_urls: [...redirects, ...addedRedirects],
        pkce_enabled: wanted.pkce_enabled,
        scopes: { ...config.scopes, user: [...userScopes, ...addedScopes] },
      },
    },
  }
}

/** The app `slack app update` changes: `--app`, else the app id stored for the selected workspace. */
async function updateTarget(
  deps: AppDeps,
  flag: string | undefined,
  workspace: string | undefined,
): Promise<Outcome<string>> {
  if (flag !== undefined) return { ok: true, value: flag }
  const stored = await readStore(deps.store)
  if (!stored.ok) return stored
  const teamId = selectedWorkspace(workspace, deps.env, stored.value)
  if (teamId === undefined)
    return {
      ok: false,
      error: {
        code: 'APP_ID_REQUIRED',
        message: 'No workspace is signed in; pass --app with the app id (A…) to update',
      },
    }
  const team = stored.value.teams[teamId]
  if (team === undefined) return { ok: false, error: unknownWorkspace(teamId, stored.value) }
  if (team.appId !== undefined) return { ok: true, value: team.appId }
  if (team.clientId === undefined || slackApp(team.clientId) === 'shared')
    return {
      ok: false,
      error: {
        code: 'NOT_OWN_APP',
        message: `${teamId} signs in through the shared app, which this CLI keeps up to date; slack app create makes the workspace an app of its own`,
      },
    }
  return {
    ok: false,
    error: {
      code: 'APP_ID_REQUIRED',
      message: `The app id of ${teamId}'s own app (client id ${team.clientId}) is not stored; pass --app with the App ID shown under Basic Information at https://api.slack.com/apps`,
    },
  }
}

function writer(deps: AppDeps): (text: string) => void {
  return deps.oauth?.write ?? ((text: string) => process.stdout.write(text))
}

/** Web API access with the configuration token, which is never stored. */
function configured(deps: AppDeps, token: string): WebApiDeps {
  return {
    fetch: deps.fetch,
    origin: deps.origin,
    credential: async () => ({ ok: true, value: { token, source: 'configuration' } }),
  }
}

/** Reads and validates the configuration token; failures never repeat what was entered. */
async function readToken(deps: AppDeps): Promise<Outcome<string>> {
  const read = deps.readConfigurationToken ?? readConfigurationTokenFromTerminal
  let entered: string
  try {
    entered = await read({ prompt: configurationTokenPrompt, timeoutMs: OAUTH_TIMEOUT_MS })
  } catch (error) {
    // Cancelled, timed out, or stdin failed: in every case no token was entered.
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: {
        code: 'CONFIG_TOKEN_REQUIRED',
        message: `No app configuration token was read: ${reason}`,
      },
    }
  }
  return configurationToken(entered)
}

/** Validates the entered token without ever repeating it. */
function configurationToken(entered: string): Outcome<string> {
  const token = entered.trim()
  if (token === '')
    return {
      ok: false,
      error: {
        code: 'CONFIG_TOKEN_REQUIRED',
        message:
          'No app configuration token was entered. Generate one at https://api.slack.com/apps (Your App Configuration Tokens), then paste it at the prompt or pipe it on stdin',
      },
    }
  if (!configurationTokenPattern.test(token))
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGUMENT',
        message:
          'Expected an app configuration access token (xoxe.xoxp-…); refresh tokens and user tokens do not work here',
      },
    }
  return { ok: true, value: token }
}

/** The app exists, so the next step is login through it, not another create. */
function notSignedIn(
  appId: string,
  clientId: string,
  options: SignInFlags,
  failure: Failure,
): CommandError {
  return {
    code: failure.code,
    message: `Created app ${appId} (client id ${clientId}), but sign-in failed: ${failure.message}`,
    cta: {
      commands: [
        {
          command: loginCommand(clientId, options),
          description: 'Sign in through the created app',
        },
      ],
    },
  }
}

type SignInFlags = { write: boolean; paste: boolean }

/** The `slack login` that finishes an app create, keeping its flags. */
function loginCommand(clientId: string, options: SignInFlags): string {
  return `login --client-id ${clientId}${options.write ? ' --write' : ''}${options.paste ? ' --paste' : ''}`
}

async function readConfigurationTokenFromTerminal(input: {
  prompt: string
  timeoutMs: number
}): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) return readPiped(stdin, configurationTokenCharsMax, input.timeoutMs)
  return readHidden(stdin, process.stderr, input.prompt, input.timeoutMs)
}

/** Reads piped stdin to its end, up to one character past `charsMax`, within `timeoutMs`. */
async function readPiped(
  stream: NodeJS.ReadStream,
  charsMax: number,
  timeoutMs: number,
): Promise<string> {
  const timer = setTimeout(
    () => stream.destroy(new Error(`stdin did not end within ${timeoutMs / 1000}s`)),
    timeoutMs,
  )
  try {
    let text = ''
    for await (const chunk of stream) {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      if (text.length > charsMax) return text.slice(0, charsMax + 1)
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}

/** Reads one line from the terminal in raw mode, so the token is never echoed. */
function readHidden(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  output.write(prompt)
  return new Promise((resolve, reject) => {
    let entered = ''
    const finish = (error?: Error) => {
      clearTimeout(timer)
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
      output.write('\n')
      if (error === undefined) resolve(entered)
      else reject(error)
    }
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        // Enter submits; Ctrl-D ends input as on a cooked terminal.
        if (char === '\r' || char === '\n' || char === '\u0004') return finish()
        if (char === '\u0003') return finish(new Error('Cancelled'))
        if (char === '\u007f' || char === '\b') entered = entered.slice(0, -1)
        else if (entered.length <= configurationTokenCharsMax) entered += char
      }
    }
    const timer = setTimeout(
      () => finish(new Error(`No configuration token was entered within ${timeoutMs / 1000}s`)),
      timeoutMs,
    )
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}
