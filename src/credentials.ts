import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from '@alleneubank/incur'

const fileMode = 0o600
const dirMode = 0o700
const lockWaitMs = 15_000
/**
 * No hold lasts this long: the longest is one token refresh, bounded by its
 * 30 s HTTP timeout. An older lock is abandoned even if its pid is running,
 * because the pid may since have been reused.
 */
const lockHeldMsMax = 120_000
const lockRetryMs = 25

export type TeamCredentials = {
  accessToken: string
  refreshToken?: string | undefined
  /** Epoch milliseconds when the access token expires; present for rotating tokens. */
  expiresAt?: number | undefined
  /** OAuth client that issued the token; refresh must use the same one. */
  clientId?: string | undefined
  userId?: string | undefined
  teamName?: string | undefined
  /** User scopes Slack reported at the last login or refresh. */
  scopes?: string[] | undefined
}

export type CredentialsFile = {
  version: 1
  currentTeamId?: string | undefined
  teams: Record<string, TeamCredentials>
}

type LegacyCredentials = {
  accessToken: string
  refreshToken?: string | undefined
  teamId: string
  userId?: string | undefined
}

const teamSchema: z.ZodType<TeamCredentials> = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().int().optional(),
  clientId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  teamName: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)).optional(),
})

const fileSchema: z.ZodType<CredentialsFile> = z.object({
  version: z.literal(1),
  currentTeamId: z.string().min(1).optional(),
  teams: z.record(z.string().min(1), teamSchema),
})

/** Single-team file written before multi-workspace support. */
const legacySchema: z.ZodType<LegacyCredentials> = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  teamId: z.string().min(1),
  userId: z.string().min(1).optional(),
})

/** The credentials file exists but cannot be used. Carries the path, never the contents. */
export class CredentialsError extends Error {
  override name = 'CredentialsError'
}

/** Another running process holds the credentials lock. */
export class CredentialsLockedError extends CredentialsError {
  override name = 'CredentialsLockedError'
}

export type CredentialReader = {
  /** The stored workspaces; empty when nothing is stored. */
  read(): Promise<CredentialsFile>
}

/** The store while its lock is held. Writing fails once the lock has been taken over. */
export type LockedCredentials = CredentialReader & {
  write(file: CredentialsFile): Promise<void>
  clear(): Promise<void>
}

export type CredentialStore = CredentialReader & {
  /**
   * Runs `change` while holding an exclusive lock, so read-modify-write
   * sequences do not interleave. The store can be written only inside it.
   */
  withLock<result>(change: (locked: LockedCredentials) => Promise<result>): Promise<result>
}

export const EMPTY_CREDENTIALS: CredentialsFile = { version: 1, teams: {} }

export function credentialsPath(home: string = os.homedir()): string {
  return path.join(home, '.config', 'slack-cli', 'credentials.json')
}

export function fileCredentialStore(file: string = credentialsPath()): CredentialStore {
  const lock = `${file}.lock`
  const read = (): Promise<CredentialsFile> => readCredentials(file)
  return {
    read,
    async withLock(change) {
      const owner = await acquire(lock)
      const assertHeld = async (): Promise<void> => {
        if ((await readLock(lock))?.owner !== owner)
          throw new CredentialsLockedError(`${lock} was taken over; nothing was written`)
      }
      try {
        return await change({
          read,
          async write(credentials) {
            await assertHeld()
            await writeCredentials(file, credentials)
          },
          async clear() {
            await assertHeld()
            await removeCredentials(file)
          },
        })
      } finally {
        await release(lock, owner)
      }
    },
  }
}

async function readCredentials(file: string): Promise<CredentialsFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_CREDENTIALS
    throw new CredentialsError(`Cannot read ${file}`, { cause: error })
  }
  return parseCredentials(text, file)
}

async function writeCredentials(file: string, credentials: CredentialsFile): Promise<void> {
  const text = `${JSON.stringify(fileSchema.parse(credentials))}\n`
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: dirMode })
    await writeFile(tmp, text, { mode: fileMode })
    await rename(tmp, file)
  } catch (error) {
    throw new CredentialsError(`Cannot write ${file}`, { cause: error })
  }
}

async function removeCredentials(file: string): Promise<void> {
  try {
    await rm(file, { force: true })
  } catch (error) {
    throw new CredentialsError(`Cannot remove ${file}`, { cause: error })
  }
}

function parseCredentials(text: string, file: string): CredentialsFile {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new CredentialsError(`${file} is not JSON`, { cause: error })
  }
  const current = fileSchema.safeParse(json)
  if (current.success) return current.data
  const legacy = legacySchema.safeParse(json)
  if (!legacy.success) throw new CredentialsError(`${file} is not a slack-cli credentials file`)
  const { teamId, ...team } = legacy.data
  return { version: 1, currentTeamId: teamId, teams: { [teamId]: team } }
}

/**
 * Creates the lock file exclusively, naming this process as its owner. A lock
 * is taken over when its owner process has exited or it is older than
 * `lockHeldMsMax`; a holder that overran the bound (suspended, say) finds its
 * writes refused. Otherwise waiters give up after `lockWaitMs`.
 */
async function acquire(lock: string): Promise<string> {
  const owner = `${process.pid} ${randomUUID()}`
  const deadline = Date.now() + lockWaitMs
  for (;;) {
    try {
      await mkdir(path.dirname(lock), { recursive: true, mode: dirMode })
      await writeFile(lock, owner, { flag: 'wx', mode: fileMode })
      return owner
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new CredentialsError(`Cannot create ${lock}`, { cause: error })
    }
    const holder = await readLock(lock)
    if (holder !== undefined && isAbandoned(holder)) {
      // Remove it only if it has not changed hands since it was judged abandoned.
      if ((await readLock(lock))?.owner === holder.owner) await rm(lock, { force: true })
      continue
    }
    if (Date.now() >= deadline)
      throw new CredentialsLockedError(`Timed out after ${lockWaitMs}ms waiting for ${lock}`)
    await new Promise((resolve) => setTimeout(resolve, lockRetryMs))
  }
}

type LockHolder = { owner: string; modifiedMs: number }

async function readLock(lock: string): Promise<LockHolder | undefined> {
  try {
    const [owner, info] = await Promise.all([readFile(lock, 'utf8'), stat(lock)])
    return { owner, modifiedMs: info.mtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new CredentialsError(`Cannot inspect ${lock}`, { cause: error })
  }
}

function isAbandoned(holder: LockHolder): boolean {
  if (Date.now() - holder.modifiedMs > lockHeldMsMax) return true
  // An ownerless lock (a crash between creating and writing it) waits out the bound.
  const pid = Number(holder.owner.split(' ')[0])
  return Number.isInteger(pid) && pid > 0 && !isRunning(pid)
}

/**
 * Removes the lock if this owner still holds it. A lock that cannot be removed
 * is reclaimed by the next acquirer once this process exits or the lock ages
 * past `lockHeldMsMax`, so the failure never replaces the change's outcome.
 */
async function release(lock: string, owner: string): Promise<void> {
  try {
    if ((await readLock(lock))?.owner === owner) await rm(lock, { force: true })
  } catch {
    // Left for the next acquirer to reclaim, as above.
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
