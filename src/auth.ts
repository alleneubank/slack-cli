import {
  CredentialsError,
  CredentialsLockedError,
  type CredentialReader,
  type CredentialStore,
  type CredentialsFile,
} from './credentials.js'
import { refreshSlackUserToken } from './oauth.js'
import type { Failure, Outcome } from './errors.js'
import type { Credential } from './web-api.js'

/** A stored rotating token is refreshed when it expires within this window. */
export const REFRESH_BEFORE_EXPIRY_MS: number = 5 * 60_000

export type AuthDeps = {
  env: Record<string, string | undefined>
  store: CredentialStore
  fetch: (request: Request) => Response | Promise<Response>
  now: () => number
  /** Client id for entries stored before login recorded one. */
  clientId: string
}

/** Resolves `SLACK_TOKEN`, else the stored workspace named by `--workspace`, `SLACK_WORKSPACE`, or the current one. */
export function credentialResolver(
  deps: AuthDeps,
): (workspace: string | undefined) => Promise<Outcome<Credential>> {
  return async (workspace) => {
    const token = envToken(deps.env)
    if (token !== undefined) return { ok: true, value: { token, source: 'environment' } }

    const stored = await readStore(deps.store)
    if (!stored.ok) return stored
    const teams = stored.value.teams
    const teamId = selectedWorkspace(workspace, deps.env, stored.value)
    if (teamId === undefined || Object.keys(teams).length === 0)
      return failure('AUTH_REQUIRED', 'Run slack login, or set SLACK_TOKEN.')
    const team = teams[teamId]
    if (team === undefined) return { ok: false, error: unknownWorkspace(teamId, stored.value) }

    if (team.refreshToken === undefined)
      return { ok: true, value: { token: team.accessToken, source: 'stored' } }
    const refresh = () => refreshTeam(deps, teamId, team.accessToken)
    const expiring =
      team.expiresAt !== undefined && team.expiresAt - deps.now() < REFRESH_BEFORE_EXPIRY_MS
    if (!expiring)
      return { ok: true, value: { token: team.accessToken, source: 'stored', refresh } }
    const refreshed = await refresh()
    return refreshed.ok
      ? { ok: true, value: { token: refreshed.value, source: 'stored' } }
      : refreshed
  }
}

/** `SLACK_TOKEN`, which overrides every stored workspace when set. */
export function envToken(env: Record<string, string | undefined>): string | undefined {
  return nonEmpty(env['SLACK_TOKEN'])
}

export function unknownWorkspace(teamId: string, file: CredentialsFile): Failure {
  const stored = Object.keys(file.teams).toSorted()
  return {
    code: 'UNKNOWN_WORKSPACE',
    message: `No stored credentials for ${teamId}. Stored workspaces: ${stored.join(', ') || 'none'}`,
  }
}

export function selectedWorkspace(
  workspace: string | undefined,
  env: Record<string, string | undefined>,
  file: CredentialsFile,
): string | undefined {
  return nonEmpty(workspace) ?? nonEmpty(env['SLACK_WORKSPACE']) ?? file.currentTeamId
}

export async function readStore(store: CredentialReader): Promise<Outcome<CredentialsFile>> {
  try {
    return { ok: true, value: await store.read() }
  } catch (error) {
    return { ok: false, error: credentialsFailure(error) }
  }
}

/** Maps a credential store failure to a command error; anything else is a bug and rethrows. */
export function credentialsFailure(error: unknown): Failure {
  if (error instanceof CredentialsLockedError)
    return {
      code: 'CREDENTIALS_LOCKED',
      message: `${error.message}. Another slack command is updating credentials; retry.`,
      retryable: true,
    }
  if (!(error instanceof CredentialsError)) throw error
  return {
    code: 'CREDENTIALS_INVALID',
    message: `${error.message}. Run slack logout --all, then slack login.`,
  }
}

/**
 * Refreshes one workspace under the store lock. Slack revokes a refresh token
 * once used, so the file is re-read after locking (another process may already
 * have refreshed) and the new pair is persisted before the token is returned.
 */
async function refreshTeam(
  deps: AuthDeps,
  teamId: string,
  staleAccessToken: string,
): Promise<Outcome<string>> {
  try {
    return await deps.store.withLock(async (locked) => {
      const file = await locked.read()
      const team = file.teams[teamId]
      if (team === undefined) return failure('AUTH_REQUIRED', `Run slack login for ${teamId}.`)
      if (team.accessToken !== staleAccessToken) return { ok: true, value: team.accessToken }
      if (team.refreshToken === undefined) return expired(teamId, 'no refresh token')

      const clientId = team.clientId ?? deps.clientId
      let issued: Awaited<ReturnType<typeof refreshSlackUserToken>>
      try {
        issued = await refreshSlackUserToken({
          clientId,
          refreshToken: team.refreshToken,
          fetch: deps.fetch,
        })
      } catch (error) {
        return expired(teamId, error instanceof Error ? error.message : String(error))
      }
      // Without a new refresh token the old one is already revoked; keep only the access token.
      const { refreshToken: _revoked, expiresAt: _expired, ...kept } = team
      await locked.write({
        ...file,
        teams: {
          ...file.teams,
          [teamId]: {
            ...kept,
            accessToken: issued.accessToken,
            clientId,
            ...(issued.refreshToken === undefined
              ? undefined
              : { refreshToken: issued.refreshToken }),
            ...(issued.expiresIn === undefined
              ? undefined
              : { expiresAt: deps.now() + issued.expiresIn * 1000 }),
            ...(issued.teamName === undefined ? undefined : { teamName: issued.teamName }),
            ...(issued.scopes === undefined ? undefined : { scopes: issued.scopes }),
          },
        },
      })
      return { ok: true, value: issued.accessToken }
    })
  } catch (error) {
    return { ok: false, error: credentialsFailure(error) }
  }
}

function expired(teamId: string, reason: string): Outcome<never> {
  return failure(
    'AUTH_EXPIRED',
    `Slack token for ${teamId} could not be refreshed (${reason}). Run slack login.`,
  )
}

function failure(code: string, message: string): Outcome<never> {
  const error: Failure = { code, message }
  return { ok: false, error }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}
