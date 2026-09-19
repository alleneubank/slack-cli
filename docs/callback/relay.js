// Decides what the OAuth redirect page does with Slack's redirect. Slack
// requires an HTTPS redirect for distributed apps, so `slack login` registers
// this static page and the page hands the code to the CLI. The code is useless
// without the PKCE verifier, which never leaves the user's computer.

/** Where `slack login` listens for the code on the user's own computer. */
export const LOOPBACK_CALLBACK_URL = 'http://127.0.0.1:8912/callback'

// `slack login` sends `loopback.<random>` or `paste.<random>` as the OAuth state.
const loopbackState = /^loopback\.[A-Za-z0-9_-]{16,64}$/
const pasteState = /^paste\.[A-Za-z0-9_-]{16,64}$/
// Slack codes and error names use only these characters. Anything else, such
// as terminal escape sequences in a crafted link, is never shown, copied, or
// forwarded; the page tells people to paste what it shows into a terminal.
const oauthValue = /^[A-Za-z0-9._-]{1,512}$/

/**
 * @typedef {{ kind: 'forward', url: string }
 *   | { kind: 'paste', code: string }
 *   | { kind: 'failed', error: string }
 *   | { kind: 'install' }} RelayAction
 */

/**
 * Only a CLI-shaped state is acted on, and a forward goes only to the fixed
 * loopback URL with only the OAuth fields, so the page is not an open redirect.
 * @param {string} search `location.search` of the redirect
 * @returns {RelayAction}
 */
export function relayAction(search) {
  const params = new URLSearchParams(search)
  const state = params.get('state') ?? ''
  const code = params.get('code')
  const error = params.get('error')
  const delivery = loopbackState.test(state) ? 'loopback' : pasteState.test(state) ? 'paste' : null
  if (delivery === null) return { kind: 'install' }
  if (code !== null && !oauthValue.test(code)) return { kind: 'failed', error: 'invalid_code' }
  if (error !== null && !oauthValue.test(error)) return { kind: 'failed', error: 'invalid_error' }
  if (delivery === 'loopback') {
    const forwarded = new URLSearchParams({ state })
    if (code !== null) forwarded.set('code', code)
    if (error !== null) forwarded.set('error', error)
    return { kind: 'forward', url: `${LOOPBACK_CALLBACK_URL}?${forwarded}` }
  }
  if (error !== null) return { kind: 'failed', error }
  if (code === null) return { kind: 'failed', error: 'missing_code' }
  return { kind: 'paste', code }
}
