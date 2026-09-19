import { OAUTH_READ_SCOPES, OAUTH_WRITE_SCOPES } from './oauth.js'

/** A command failure, before it is mapped to an exit code and a next step. */
export type Failure = {
  code: string
  message: string
  /** Retrying the same command unchanged may succeed. */
  retryable?: boolean | undefined
  /** Scopes Slack named for `missing_scope`; any one of them is enough. */
  neededScopes?: string[] | undefined
  /** Where the rejected token came from; never included in command output. */
  credentialSource?: 'environment' | 'stored' | undefined
}

export type Outcome<value> = { ok: true; value: value } | { ok: false; error: Failure }

/** Exit code for a failure that may succeed when retried unchanged. */
export const EXIT_RETRYABLE: number = 3
/** Exit code for a failure that a new `slack login` fixes. */
export const EXIT_LOGIN: number = 4

type Step = { command: string; description: string }

export type CommandError = {
  code: string
  message: string
  retryable?: boolean | undefined
  exitCode?: number | undefined
  cta?: { commands: Step[] } | undefined
}

const listWorkspaces: Step = {
  command: 'workspaces list',
  description: 'Show the stored workspaces',
}
const login: Step = { command: 'login', description: 'Authorize the workspace again' }
const loginWrite: Step = {
  command: 'login --write',
  description: 'Authorize the workspace with write scopes',
}

/** Failures meaning there is no usable token: nothing stored, or Slack rejected it. */
const tokenRejected = new Set([
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'account_inactive',
  'invalid_auth',
  'not_authed',
  'token_expired',
  'token_revoked',
])

/** Maps a failure to the exit code and next step an agent acts on. */
export function commandError(failure: Failure): CommandError {
  const { neededScopes, credentialSource, ...error } = failure
  if (error.retryable === true) return { ...error, exitCode: EXIT_RETRYABLE }
  if (error.code === 'UNKNOWN_WORKSPACE') return { ...error, cta: { commands: [listWorkspaces] } }
  if (
    credentialSource === 'environment' &&
    (tokenRejected.has(error.code) || error.code === 'missing_scope')
  )
    return { ...error, message: `${error.message}; fix or unset SLACK_TOKEN before retrying` }
  const steps = loginSteps(error.code, neededScopes ?? [])
  if (steps !== undefined) return { ...error, exitCode: EXIT_LOGIN, cta: { commands: steps } }
  if (error.code === 'missing_scope')
    return {
      ...error,
      message: `${error.message}; slack login cannot grant it; set SLACK_TOKEN to a token that has it`,
    }
  return error
}

function loginSteps(code: string, neededScopes: string[]): Step[] | undefined {
  if (tokenRejected.has(code)) return [login]
  if (code === 'CREDENTIALS_INVALID')
    return [{ command: 'logout --all', description: 'Remove the unreadable credentials' }, login]
  if (code !== 'missing_scope') return undefined
  if (neededScopes.some((scope) => OAUTH_READ_SCOPES.includes(scope))) return [login]
  if (neededScopes.some((scope) => OAUTH_WRITE_SCOPES.includes(scope))) return [loginWrite]
  // Login does not request this scope, so logging in again cannot grant it.
  return undefined
}
