import { describe, expect, test } from 'vitest'

import {
  authorizeSlackUser,
  oauthScopes,
  OAUTH_AUTHORIZE_URL,
  OAUTH_CALLBACK_FAILURE_HTML,
  OAUTH_CALLBACK_SUCCESS_HTML,
  OAUTH_TOKEN_URL,
} from './oauth.js'

const accessToken = 'tok-access-not-a-secret'
const authCode = 'auth-code-not-a-secret'

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
