import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, onTestFinished, test } from 'vitest'

import { CredentialsLockedError, fileCredentialStore, type CredentialsFile } from './credentials.js'

function storeFile(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'slack-cli-'))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'credentials.json')
}

function tenMinutesAgo(): Date {
  return new Date(Date.now() - 10 * 60_000)
}

function onlyTeam(teamId: string): CredentialsFile {
  return { version: 1, currentTeamId: teamId, teams: { [teamId]: { accessToken: 'token' } } }
}

describe('credential store lock', () => {
  test('a lock held by a running process is not taken over', async () => {
    const store = fileCredentialStore(storeFile())
    const events: string[] = []
    let holding!: () => void
    const held = new Promise<void>((resolve) => {
      holding = resolve
    })
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = store.withLock(async () => {
      events.push('first:start')
      holding()
      await released
      events.push('first:end')
    })
    await held
    const second = store.withLock(async () => {
      events.push('second:start')
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
  })

  test('a lock left by a process that exited is taken over', async () => {
    const file = storeFile()
    const exited = spawnSync(process.execPath, ['-e', '']).pid
    writeFileSync(`${file}.lock`, `${exited} abandoned`)
    await expect(fileCredentialStore(file).withLock(async () => 'entered')).resolves.toBe('entered')
  })

  test('a lock older than any hold is taken over even while its pid runs', async () => {
    // This test process stands in for an unrelated process that reused a crashed owner's pid.
    const file = storeFile()
    writeFileSync(`${file}.lock`, `${process.pid} crashed-owner`)
    utimesSync(`${file}.lock`, tenMinutesAgo(), tenMinutesAgo())
    await expect(fileCredentialStore(file).withLock(async () => 'entered')).resolves.toBe('entered')
  })

  test('an empty lock older than any hold is taken over', async () => {
    const file = storeFile()
    writeFileSync(`${file}.lock`, '')
    utimesSync(`${file}.lock`, tenMinutesAgo(), tenMinutesAgo())
    await expect(fileCredentialStore(file).withLock(async () => 'entered')).resolves.toBe('entered')
  })

  test('a holder whose lock was taken over cannot write', async () => {
    const file = storeFile()
    const store = fileCredentialStore(file)
    let holding!: () => void
    const held = new Promise<void>((resolve) => {
      holding = resolve
    })
    let resume!: () => void
    const resumed = new Promise<void>((resolve) => {
      resume = resolve
    })
    const overrun = store.withLock(async (locked) => {
      utimesSync(`${file}.lock`, tenMinutesAgo(), tenMinutesAgo())
      holding()
      await resumed
      await locked.write(onlyTeam('T_OVERRUN'))
    })
    await held
    await store.withLock(async (locked) => {
      await locked.write(onlyTeam('T_NEXT'))
    })
    resume()
    await expect(overrun).rejects.toBeInstanceOf(CredentialsLockedError)
    expect(Object.keys((await store.read()).teams)).toEqual(['T_NEXT'])
  })

  test('a lock that cannot be released does not replace the outcome of the change', async () => {
    const file = storeFile()
    const outcome = fileCredentialStore(file).withLock(async () => {
      chmodSync(`${file}.lock`, 0)
      return 'changed'
    })
    await expect(outcome).resolves.toBe('changed')
  })
})
