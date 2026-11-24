import { readFile } from 'node:fs/promises'

import { Cli, z } from '@alleneubank/incur'

import { commandError, type CommandError, type Failure, type Outcome } from './errors.js'
import { signedInOutput, signIn, signInOptions, type LoginDeps } from './login.js'
import { OAUTH_TIMEOUT_MS } from './oauth.js'
import { CLIENT_ID_PATTERN } from './slack-app.js'
import { callSlackMethod } from './web-api.js'

/**
 * Reads an app configuration token: from a hidden prompt on a terminal, or
 * from stdin when it is piped. Returns what was entered, untrimmed.
 */
export type ConfigurationTokenReader = (input: {
  prompt: string
  timeoutMs: number
}) => Promise<string>

export type AppDeps = LoginDeps & {
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
      "Create the workspace's own Slack app, which Slack does not rate-limit like the shared app",
  }).command('create', {
    description:
      'Create a Slack app from the bundled manifest in the workspace of an app configuration token, read from a hidden prompt or stdin, then sign in through it',
    options: z.object(signInOptions),
    output: signedInOutput.extend({ appId: z.string().describe('Id of the created Slack app') }),
    mutates: true,
    async run(context) {
      const write = deps.oauth?.write ?? ((text: string) => process.stdout.write(text))
      const read = deps.readConfigurationToken ?? readConfigurationTokenFromTerminal
      let entered: string
      try {
        entered = await read({ prompt: configurationTokenPrompt, timeoutMs: OAUTH_TIMEOUT_MS })
      } catch (error) {
        // Cancelled, timed out, or stdin failed: in every case no token was entered.
        const reason = error instanceof Error ? error.message : String(error)
        return context.error(
          commandError({
            code: 'CONFIG_TOKEN_REQUIRED',
            message: `No app configuration token was read: ${reason}`,
          }),
        )
      }
      const token = configurationToken(entered)
      if (!token.ok) return context.error(commandError(token.error))

      const manifest = await readFile(deps.manifestPath, 'utf8')
      const created = await callSlackMethod('apps.manifest.create', { manifest }, undefined, {
        fetch: deps.fetch,
        origin: deps.origin,
        credential: async () => ({
          ok: true,
          value: { token: token.value, source: 'configuration' },
        }),
      })
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
          { ...options, announce: `App: own app ${clientId}\n` },
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return context.error(
          notSignedIn(appId, clientId, options, { code: 'SIGN_IN_FAILED', message }),
        )
      }
      if (!signedIn.ok) return context.error(notSignedIn(appId, clientId, options, signedIn.error))
      write(
        'If this workspace also signed in through the shared app, it stays authorized there; remove it under Manage apps in Slack.\n',
      )
      return { ...signedIn.value, appId }
    },
  })
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
