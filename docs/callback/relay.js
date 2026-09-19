// Decides what the OAuth redirect page does with Slack's redirect. Slack
// requires an HTTPS redirect for distributed apps, so `slack login` registers
// this static page and the page hands the code to the CLI. The code is useless
// without the PKCE verifier, which never leaves the user's computer.

/** Where `slack login` listens for the code on the user's own computer. */
export const LOOPBACK_CALLBACK_URL = 'http://127.0.0.1:8912/callback'

// `slack login` sends `loopback.<random>` or `paste.<random>` as the OAuth state.
const loopbackState = /^loopback\.[A-Za-z0-9_-]{16,64}$/
const pasteState = /^paste\.[A-Za-z0-9_-]{16,64}$/

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
  if (loopbackState.test(state)) {
    const forwarded = new URLSearchParams({ state })
    if (code !== null) forwarded.set('code', code)
    if (error !== null) forwarded.set('error', error)
    return { kind: 'forward', url: `${LOOPBACK_CALLBACK_URL}?${forwarded}` }
  }
  if (pasteState.test(state)) {
    if (error !== null) return { kind: 'failed', error }
    if (code === null || code === '') return { kind: 'failed', error: 'missing_code' }
    return { kind: 'paste', code }
  }
  return { kind: 'install' }
}
