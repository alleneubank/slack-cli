import { relayAction } from './relay.js'

const action = relayAction(window.location.search)

if (action.kind === 'forward') {
  show('forward')
  window.location.replace(action.url)
} else {
  // The code is single-use and bound to the CLI's PKCE verifier; still keep it
  // out of the address bar and browser history.
  window.history.replaceState(null, '', window.location.pathname)
  if (action.kind === 'paste') showCode(action.code)
  else if (action.kind === 'failed') {
    document.getElementById('error').textContent = action.error
    show('failed')
  } else show('install')
}

/** @param {string} id */
function show(id) {
  document.getElementById(id).hidden = false
}

/** @param {string} code */
function showCode(code) {
  document.getElementById('code').textContent = code
  const copy = document.getElementById('copy')
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(code)
    copy.textContent = 'Copied'
  })
  show('paste')
}
