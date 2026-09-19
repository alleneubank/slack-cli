import { describe, expect, test } from 'vitest'

import { LOOPBACK_CALLBACK_URL, relayAction } from '../docs/callback/relay.js'
import {
  authorizeSlackUser,
  oauthScopes,
  parsePastedCode,
  OAUTH_AUTHORIZE_URL,
  OAUTH_CALLBACK_FAILURE_HTML,
  OAUTH_CALLBACK_SUCCESS_HTML,
  OAUTH_LOOPBACK_URL,
  OAUTH_REDIRECT_URI,
  OAUTH_TOKEN_URL,
  type CodeDelivery,
} from './oauth.js'

const accessToken = 'tok-access-not-a-secret'
const authCode = 'auth-code-not-a-secret'

/** Runs a login with a fixed code and returns the authorize URL and token request body. */
async function authorize(delivery?: CodeDelivery) {
  let authorizeUrl = ''
  let tokenBody = new URLSearchParams()
  await authorizeSlackUser({
    clientId: 'cid-test',
    timeoutMs: 1_000,
    ...(delivery === undefined ? undefined : { delivery }),
    async openUrl(url) {
      authorizeUrl = url
    },
    async waitForCode() {
      return { code: authCode }
    },
    async fetch(request) {
      tokenBody = new URLSearchParams(await request.text())
      return Response.json({ ok: true, access_token: accessToken, team: { id: 'T1' } })
    },
  })
  return { authorize: new URL(authorizeUrl), tokenBody }
}

describe('HTTPS redirect relay', () => {
  test('login redirects through the relay page and exchanges with the same redirect', async () => {
    const { authorize: url, tokenBody } = await authorize()
    expect(OAUTH_REDIRECT_URI).toBe('https://alleneubank.github.io/slack-cli/callback/')
    expect(url.searchParams.get('redirect_uri')).toBe(OAUTH_REDIRECT_URI)
    expect(tokenBody.get('redirect_uri')).toBe(OAUTH_REDIRECT_URI)
    expect(tokenBody.has('client_secret')).toBe(false)
  })

  test('the state tells the relay page how the CLI receives the code', async () => {
    const loopback = (await authorize()).authorize.searchParams.get('state')!
    const paste = (await authorize('paste')).authorize.searchParams.get('state')!
    expect(loopback).toMatch(/^loopback\.[\w-]{22}$/)
    expect(paste).toMatch(/^paste\.[\w-]{22}$/)
  })

  test('a loopback login is forwarded only to the CLI listener, with only OAuth fields', () => {
    expect(LOOPBACK_CALLBACK_URL).toBe(OAUTH_LOOPBACK_URL)
    const state = 'loopback.AAAAAAAAAAAAAAAAAAAAAA'
    const action = relayAction(`?code=c-1&state=${state}&next=https://attacker.example/`)
    expect(action).toEqual({
      kind: 'forward',
      url: `http://127.0.0.1:8912/callback?state=${state}&code=c-1`,
    })
    expect(relayAction(`?error=access_denied&state=${state}`)).toEqual({
      kind: 'forward',
      url: `http://127.0.0.1:8912/callback?state=${state}&error=access_denied`,
    })
  })

  test('a paste login shows the code; a denied one shows the error', () => {
    const state = 'paste.AAAAAAAAAAAAAAAAAAAAAA'
    expect(relayAction(`?code=c-1&state=${state}`)).toEqual({ kind: 'paste', code: 'c-1' })
    expect(relayAction(`?error=access_denied&state=${state}`)).toEqual({
      kind: 'failed',
      error: 'access_denied',
    })
    expect(relayAction(`?state=${state}`)).toEqual({ kind: 'failed', error: 'missing_code' })
  })

  test('a visit without a CLI state is never forwarded', () => {
    for (const search of [
      '',
      '?code=c-1',
      '?code=c-1&state=abc',
      '?code=c-1&state=loopback.',
      '?code=c-1&state=loopback.AAAAAAAAAAAAAAAAAAAAAA/../x',
      '?code=c-1&state=paste.AAAAAAAAAAAAAAAAAAAAAA%0A',
    ])
      expect(relayAction(search)).toEqual({ kind: 'install' })
  })

  test('a pasted code is trimmed; anything else is rejected without echoing it', () => {
    expect(parsePastedCode('  12085301315143.1234.abcdef \n')).toBe('12085301315143.1234.abcdef')
    for (const pasted of ['', 'not a code', 'https://example.com/?code=1', 'x'.repeat(600)]) {
      expect(() => parsePastedCode(pasted)).toThrow('not a Slack authorization code')
      try {
        parsePastedCode(pasted)
      } catch (error) {
        if (pasted.length > 0) expect(String(error)).not.toContain(pasted)
      }
    }
  })
})

describe('Slack user OAuth', () => {
  test('exchanges a loopback code for an access token and does not echo secrets', async () => {
    const opened: string[] = []
    const announced: string[] = []
    const tokenBodies: string[] = []
    const token = await authorizeSlackUser({
      clientId: 'cid-test',
      timeoutMs: 1_000,
      randomBytes: (size) => Uint8Array.from({ length: size }, () => 7),
      onAuthorizeUrl: (url) => {
        announced.push(url)
      },
      async openUrl(url) {
        opened.push(url)
      },
      async waitForCode() {
        return { code: authCode }
      },
      async fetch(request) {
        const body = await request.text()
        tokenBodies.push(body)
        expect(request.url).toBe(OAUTH_TOKEN_URL)
        return Response.json({
          ok: true,
          access_token: accessToken,
          team: { id: 'T1' },
          authed_user: { id: 'U1' },
        })
      },
    })

    expect(token).toEqual({ accessToken, teamId: 'T1', userId: 'U1' })
    expect(opened).toHaveLength(1)
    expect(announced).toEqual(opened)
    const authorizeUrl = new URL(opened[0]!)
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(OAUTH_AUTHORIZE_URL)
    expect(authorizeUrl.searchParams.get('client_id')).toBe('cid-test')
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code')
    expect(authorizeUrl.searchParams.get('scope')).toBe(oauthScopes(false))
    expect(authorizeUrl.searchParams.get('scope')).not.toContain('chat:write')
    expect(tokenBodies[0]).toContain('code_verifier')
    expect(tokenBodies[0]).not.toContain('client_secret')
  })

  test('token endpoint errors do not include the code', async () => {
    await expect(
      authorizeSlackUser({
        clientId: 'cid-test',
        timeoutMs: 1_000,
        randomBytes: (size) => Uint8Array.from({ length: size }, () => 1),
        async openUrl() {},
        async waitForCode() {
          return { code: authCode }
        },
        async fetch() {
          return Response.json({ ok: false, error: 'invalid_code' })
        },
      }),
    ).rejects.toThrow(/invalid_code/)

    try {
      await authorizeSlackUser({
        clientId: 'cid-test',
        timeoutMs: 1_000,
        randomBytes: (size) => Uint8Array.from({ length: size }, () => 1),
        async openUrl() {},
        async waitForCode() {
          return { code: authCode }
        },
        async fetch() {
          return Response.json({ ok: false, error: 'invalid_code' })
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain(authCode)
      expect(message).not.toContain(accessToken)
    }
  })

  test('callback pages link the source and say the CLI is not Slack software', () => {
    expect(OAUTH_CALLBACK_SUCCESS_HTML).toContain("You're signed in")
    for (const page of [OAUTH_CALLBACK_SUCCESS_HTML, OAUTH_CALLBACK_FAILURE_HTML]) {
      expect(page).toContain('https://unrulysystems.com')
      expect(page).toContain('href="https://github.com/alleneubank/slack-cli"')
      expect(page).toContain('Not affiliated with or endorsed by Slack.')
    }
  })
})
