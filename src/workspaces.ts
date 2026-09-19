import { Cli, z } from '@alleneubank/incur'

import {
  credentialsFailure,
  envToken,
  readStore,
  selectedWorkspace,
  unknownWorkspace,
} from './auth.js'
import type { CredentialStore, TeamCredentials } from './credentials.js'
import { commandError } from './errors.js'

export type WorkspacesDeps = {
  store: CredentialStore
  env: Record<string, string | undefined>
}

const workspaceGlobals = z.object({ workspace: z.string().optional() })

const workspaceSchema = z.object({
  teamId: z.string(),
  teamName: z.string().optional(),
  userId: z.string().optional(),
  current: z.boolean().describe('Commands use this workspace unless --workspace names another'),
  rotating: z.boolean().describe('The token expires and is refreshed automatically'),
  expiresAt: z.string().optional().describe('When the stored access token expires (ISO 8601)'),
  scopes: z
    .array(z.string())
    .optional()
    .describe('User scopes Slack reported at the last login or refresh'),
})

/** `slack workspaces`: inspect and select stored workspaces. Never prints tokens. */
export function workspacesCli(deps: WorkspacesDeps): Cli.Cli {
  const { store, env } = deps
  return Cli.create('workspaces', {
    description: 'List stored workspaces and choose the current one',
  })
    .command('list', {
      description: 'List stored workspaces, the current one, token expiry, and granted scopes',
      output: z.object({
        current: z
          .string()
          .optional()
          .describe(
            'Workspace commands use: --workspace, then SLACK_WORKSPACE, then the stored one',
          ),
        envToken: z.boolean().describe('SLACK_TOKEN is set and overrides every stored workspace'),
        workspaces: z.array(workspaceSchema),
      }),
      async run(context) {
        const stored = await readStore(store)
        if (!stored.ok) return context.error(commandError(stored.error))
        const { workspace } = workspaceGlobals.parse(context.globals)
        const current = selectedWorkspace(workspace, env, stored.value)
        const workspaces = Object.entries(stored.value.teams)
          .toSorted(([a], [b]) => (a < b ? -1 : 1))
          .map(([teamId, team]) => describe(teamId, team, teamId === current))
        return {
          ...(current === undefined ? undefined : { current }),
          envToken: envToken(env) !== undefined,
          workspaces,
        }
      },
    })
    .command('use', {
      description: 'Make a stored workspace current',
      args: z.object({ teamId: z.string().describe('Team id from slack workspaces list') }),
      output: z.object({ ok: z.literal(true), currentTeamId: z.string() }),
      mutates: true,
      async run(context) {
        const { teamId } = context.args
        try {
          return await store.withLock(async (locked) => {
            const file = await locked.read()
            if (file.teams[teamId] === undefined)
              return context.error(commandError(unknownWorkspace(teamId, file)))
            await locked.write({ ...file, currentTeamId: teamId })
            return { ok: true as const, currentTeamId: teamId }
          })
        } catch (error) {
          return context.error(commandError(credentialsFailure(error)))
        }
      },
    })
}

function describe(teamId: string, team: TeamCredentials, current: boolean) {
  return {
    teamId,
    ...(team.teamName === undefined ? undefined : { teamName: team.teamName }),
    ...(team.userId === undefined ? undefined : { userId: team.userId }),
    current,
    rotating: team.refreshToken !== undefined,
    ...(team.expiresAt === undefined
      ? undefined
      : { expiresAt: new Date(team.expiresAt).toISOString() }),
    ...(team.scopes === undefined ? undefined : { scopes: team.scopes }),
  }
}
