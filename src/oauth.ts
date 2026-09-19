import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { SOURCE_URL } from './version.js'

export const OAUTH_AUTHORIZE_URL: string = 'https://slack.com/oauth/v2_user/authorize'
export const OAUTH_TOKEN_URL: string = 'https://slack.com/api/oauth.v2.user.access'
export const OAUTH_REDIRECT_PORT: number = 8912
export const OAUTH_REDIRECT_PATH: string = '/callback'
export const OAUTH_TIMEOUT_MS: number = 300_000
export const OAUTH_REDIRECT_URI: string = `http://127.0.0.1:${OAUTH_REDIRECT_PORT}${OAUTH_REDIRECT_PATH}`

const callbackPageStyle = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  display: grid;
  place-items: center;
  padding: 24px;
  font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  color: #f4f1ea;
  background:
    radial-gradient(1200px 600px at 50% -10%, #3d3a34 0%, transparent 55%),
    #1c1b19;
}
main {
  width: min(28rem, 100%);
  padding: 2.25rem 2rem 1.5rem;
  border: 1px solid #3a3833;
  border-radius: 16px;
  background: #252422;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
  text-align: center;
}
.mark {
  display: grid;
  place-items: center;
  width: 3rem;
  height: 3rem;
  margin: 0 auto 1.25rem;
  border-radius: 999px;
  background: #2f6f4e;
  color: #e8f6ee;
  font-size: 1.35rem;
  line-height: 1;
}
.mark.fail { background: #8a3b32; color: #fbe9e7; }
h1 { margin: 0 0 0.5rem; font-size: 1.35rem; font-weight: 600; letter-spacing: -0.02em; }
p { margin: 0; color: #c8c2b6; }
footer {
  margin-top: 2rem;
  color: #8a857a;
  font-size: 0.8rem;
  letter-spacing: 0.02em;
}
footer a {
  color: #d8d2c6;
  text-decoration: none;
  border-bottom: 1px solid #5c574e;
}
footer a:hover { color: #f4f1ea; border-bottom-color: #f4f1ea; }
.disclaimer {
  display: block;
  margin-top: 0.4rem;
  color: #6f6b62;
  letter-spacing: 0.03em;
}
`

const callbackFooter = `
<footer>
  Unofficial Slack CLI by <a href="https://unrulysystems.com">unrulysystems.com</a> ·
  <a href="${SOURCE_URL}">source</a>
  <span class="disclaimer">Not affiliated with or endorsed by Slack.</span>
</footer>
`

export const OAUTH_CALLBACK_SUCCESS_HTML: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signed in · slack-cli</title>
<style>${callbackPageStyle}</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true">✓</div>
  <h1>You're signed in</h1>
  <p>You can close this window and return to the terminal.</p>
  ${callbackFooter}
</main>
</body>
</html>
`

export const OAUTH_CALLBACK_FAILURE_HTML: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign-in failed · slack-cli</title>
<style>${callbackPageStyle}</style>
</head>
<body>
<main>
  <div class="mark fail" aria-hidden="true">!</div>
  <h1>Sign-in didn't finish</h1>
  <p>You can close this window and retry <code>slack login</code> in the terminal.</p>
  ${callbackFooter}
</main>
</body>
</html>
`

export const OAUTH_READ_SCOPES: readonly string[] = [
  'canvases:read',
  'channels:history',
  'channels:read',
  'emoji:read',
  'files:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'lists:read',
  'mpim:history',
  'mpim:read',
  'reactions:read',
  'search:read',
  'search:read.files',
  'search:read.im',
  'search:read.mpim',
  'search:read.private',
  'search:read.public',
  'search:read.users',
  'users:read',
  'users:read.email',
]

export const OAUTH_WRITE_SCOPES: readonly string[] = [
  'canvases:write',
  'channels:write',
  'chat:write',
  'files:write',
  'groups:write',
  'im:write',
  'lists:write',
  'mpim:write',
  'reactions:write',
]

/** Scopes requested at login. Write scopes are opt-in. */
export function oauthScopes(write: boolean): string {
  return (write ? [...OAUTH_READ_SCOPES, ...OAUTH_WRITE_SCOPES] : OAUTH_READ_SCOPES).join(' ')
}

const maxCallbackUrlBytes = 8_192

export const OAUTH_HTTP_TIMEOUT_MS: number = 30_000

type Fetch = (request: Request) => Response | Promise<Response>

export type OauthToken = {
  accessToken: string
  refreshToken?: string | undefined
  /** Seconds until the access token expires; present for rotating tokens. */
  expiresIn?: number | undefined
  teamId?: string | undefined
  teamName?: string | undefined
  userId?: string | undefined
  /** Every user scope the token carries; Slack accumulates grants across logins. */
  scopes?: string[] | undefined
}

export type AuthorizeSlackUserOptions = {
  clientId: string
  fetch: Fetch
  openUrl: (url: string) => Promise<void>
  /** Called with the authorize URL before the browser opens. */
  onAuthorizeUrl?: (url: string) => void
  waitForCode: (input: { state: string; timeoutMs: number }) => Promise<{ code: string }>
  randomBytes?: (size: number) => Uint8Array
  timeoutMs?: number | undefined
  scope?: string | undefined
  redirectUri?: string | undefined
}

/** Slack user OAuth with public PKCE: browser consent, loopback code, code exchange. */
export async function authorizeSlackUser(
  options: AuthorizeSlackUserOptions,
): Promise<OauthToken & { teamId: string }> {
  const randomBytes = options.randomBytes ?? defaultRandomBytes
  const timeoutMs = options.timeoutMs ?? OAUTH_TIMEOUT_MS
  const redirectUri = options.redirectUri ?? OAUTH_REDIRECT_URI
  const scope = options.scope ?? oauthScopes(false)
  const verifier = base64url(randomBytes(32))
  const state = base64url(randomBytes(16))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const authorizeUrl = new URL(OAUTH_AUTHORIZE_URL)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', options.clientId)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('scope', scope)

  const authorize = authorizeUrl.toString()
  const codePromise = options.waitForCode({ state, timeoutMs })
  options.onAuthorizeUrl?.(authorize)
  try {
    await options.openUrl(authorize)
  } catch {
    // Opening a browser is optional; the printed URL is enough to finish login.
  }
  const { code } = await codePromise
  const issued = await requestToken(
    options.fetch,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: options.clientId,
      code_verifier: verifier,
    }),
  )
  if (issued.teamId === undefined)
    throw new Error('Slack OAuth token exchange failed (missing_team_id)')
  return { ...issued, teamId: issued.teamId }
}

/** Exchanges a rotating token's refresh token for a new access and refresh token. */
export async function refreshSlackUserToken(options: {
  clientId: string
  refreshToken: string
  fetch: Fetch
}): Promise<OauthToken> {
  return requestToken(
    options.fetch,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
      client_id: options.clientId,
    }),
  )
}

export async function waitForLoopbackCode(input: {
  state: string
  timeoutMs: number
  port?: number | undefined
  path?: string | undefined
}): Promise<{ code: string }> {
  const port = input.port ?? OAUTH_REDIRECT_PORT
  const path = input.path ?? OAUTH_REDIRECT_PATH
  return new Promise((resolve, reject) => {
    let settled = false
    const server = createServer((req, res) => {
      void handleCallback(req, res)
    })

    const finish = (error: Error | undefined, code?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      if (error) reject(error)
      else resolve({ code: code! })
    }

    const handleCallback = async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const host = req.headers.host ?? `127.0.0.1:${port}`
        const url = new URL(req.url ?? '/', `http://${host}`)
        if (url.pathname !== path) {
          res.writeHead(404)
          res.end()
          return
        }
        const rawUrl = req.url ?? ''
        if (rawUrl.length > maxCallbackUrlBytes) {
          res.writeHead(414)
          res.end('Request too large')
          finish(new Error('OAuth callback URL exceeded the size limit'))
          return
        }
        if (url.searchParams.get('state') !== input.state) {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end('Authorization state mismatch.')
          finish(new Error('OAuth state mismatch'))
          return
        }
        const oauthError = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        if (oauthError !== null || code === null || code.length === 0) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
          res.end(OAUTH_CALLBACK_FAILURE_HTML)
          finish(new Error(oauthError ?? 'OAuth callback missing code'))
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(OAUTH_CALLBACK_SUCCESS_HTML)
        finish(undefined, code)
      } catch (error) {
        res.writeHead(500)
        res.end()
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }

    const timer = setTimeout(() => {
      finish(new Error(`OAuth timed out after ${input.timeoutMs}ms`))
    }, input.timeoutMs)

    server.on('error', (error) => {
      finish(error instanceof Error ? error : new Error(String(error)))
    })
    server.listen(port, '127.0.0.1')
  })
}

async function requestToken(fetch: Fetch, body: URLSearchParams): Promise<OauthToken> {
  const response = await fetch(
    new Request(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
    }),
  )
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error(`Slack OAuth token endpoint returned HTTP ${response.status}`)
  }
  if (!isRecord(parsed) || parsed['ok'] !== true) {
    const code =
      isRecord(parsed) && typeof parsed['error'] === 'string'
        ? parsed['error']
        : 'token_exchange_failed'
    throw new Error(`Slack OAuth token request failed (${code})`)
  }
  // User-only OAuth returns the token at the top level; oauth.v2.access nests it in authed_user.
  const authedUser = isRecord(parsed['authed_user']) ? parsed['authed_user'] : undefined
  const holder = stringField(parsed, 'access_token') !== undefined ? parsed : authedUser
  const accessToken = holder === undefined ? undefined : stringField(holder, 'access_token')
  if (holder === undefined || accessToken === undefined)
    throw new Error('Slack OAuth token request failed (missing_access_token)')
  const refreshToken = stringField(holder, 'refresh_token')
  const expiresIn = holder['expires_in']
  const team = isRecord(parsed['team']) ? parsed['team'] : undefined
  const teamId = team === undefined ? undefined : stringField(team, 'id')
  const teamName = team === undefined ? undefined : stringField(team, 'name')
  const userId = authedUser === undefined ? undefined : stringField(authedUser, 'id')
  const scopes = stringField(holder, 'scope')
    ?.split(',')
    .filter((scope) => scope.length > 0)
  return {
    accessToken,
    ...(refreshToken === undefined ? undefined : { refreshToken }),
    ...(typeof expiresIn === 'number' && expiresIn > 0 ? { expiresIn } : undefined),
    ...(teamId === undefined ? undefined : { teamId }),
    ...(teamName === undefined ? undefined : { teamName }),
    ...(userId === undefined ? undefined : { userId }),
    ...(scopes === undefined ? undefined : { scopes }),
  }
}

function defaultRandomBytes(size: number): Uint8Array {
  return nodeRandomBytes(size)
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}
