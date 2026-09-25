import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from 'vitest'

import { createCli, SLACK_OAUTH_CLIENT_ID, type OauthHost } from './create-cli.js'
import { fileCredentialStore, type CredentialsFile } from './credentials.js'
import { EXIT_LOGIN, EXIT_RETRYABLE } from './errors.js'

const accessToken = 'xoxe.xoxp-access-not-a-secret'
const refreshToken = 'xoxe-refresh-not-a-secret'
const origin = 'http://slack.local'
const start = Date.UTC(2026, 8, 18, 12)
const hour = 3_600_000

const originalIsTTY = process.stdout.isTTY
beforeAll(() => {
  ;(process.stdout as { isTTY?: boolean }).isTTY = false
})
afterAll(() => {
  ;(process.stdout as { isTTY?: boolean }).isTTY = originalIsTTY
})

type Handler = (request: Request) => Response | Promise<Response>

type Run = { output: string; exitCode: number | undefined; json: () => any }

function credentialsFile(contents?: unknown): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'slack-cli-'))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'credentials.json')
  if (contents !== undefined) writeFileSync(file, JSON.stringify(contents), { mode: 0o600 })
  return file
}

/** Resolves once `condition` holds, or after `deadlineMs` without failing. */
async function until(condition: () => boolean, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5))
}

function readCredentials(file: string): CredentialsFile {
  return JSON.parse(readFileSync(file, 'utf8')) as CredentialsFile
}

function cli(
  options: {
    fetch?: Handler
    file?: string
    env?: Record<string, string | undefined>
    oauth?: OauthHost
    now?: () => number
  } = {},
) {
  return createCli({
    version: '0.0.0',
    apiOrigin: origin,
    env: options.env ?? {},
    credentials: fileCredentialStore(options.file ?? credentialsFile()),
    fetch: options.fetch ?? (() => Response.json({ ok: true })),
    now: options.now ?? (() => start),
    ...(options.oauth ? { oauth: options.oauth } : undefined),
  })
}

async function run(target: ReturnType<typeof cli>, argv: string[]): Promise<Run> {
  let output = ''
  let exitCode: number | undefined
  await target.serve(argv, {
    stdout: (s) => {
      output += s
    },
    stderr: (s) => {
      output += s
    },
    exit: (code) => {
      exitCode = code
    },
  })
  return { output, exitCode, json: () => JSON.parse(output) }
}

function withToken(token = accessToken) {
  return { env: { SLACK_TOKEN: token } }
}

/**
 * Slack's observable contract for these tests: Web API calls need a live
 * token, rotating tokens expire, and a refresh token works exactly once.
 */
function fakeSlack(options: { live: Set<string>; refreshable: Map<string, string> }) {
  const calls: Request[] = []
  let issued = 0
  const handler: Handler = async (request) => {
    calls.push(request.clone())
    const url = new URL(request.url)
    if (url.pathname === '/api/oauth.v2.user.access') {
      const body = new URLSearchParams(await request.text())
      const old = body.get('refresh_token') ?? ''
      if (!options.refreshable.has(old))
        return Response.json({ ok: false, error: 'invalid_refresh_token' })
      const access = options.refreshable.get(old)!
      options.refreshable.delete(old)
      options.live.delete(access)
      issued += 1
      const next = { access: `xoxe.xoxp-renewed-${issued}`, refresh: `xoxe-renewed-${issued}` }
      options.live.add(next.access)
      options.refreshable.set(next.refresh, next.access)
      return Response.json({
        ok: true,
        access_token: next.access,
        refresh_token: next.refresh,
        expires_in: 43_200,
        token_type: 'user',
        scope: 'channels:read,chat:write',
        team: { id: 'T1', name: 'Example' },
      })
    }
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    if (!options.live.has(token)) return Response.json({ ok: false, error: 'token_expired' })
    return Response.json({ ok: true, url: 'https://example.slack.com/', team_id: 'T1' })
  }
  return {
    handler,
    calls,
    refreshCalls: () => calls.filter((call) => call.url.endsWith('/oauth.v2.user.access')),
  }
}

function rotatingStore(teams: CredentialsFile['teams'], currentTeamId = 'T1'): CredentialsFile {
  return { version: 1, currentTeamId, teams }
}

describe('Slack Web API methods', () => {
  test('sends only declared arguments, form-encoded, and prints Slack JSON unchanged', async () => {
    const body = { ok: true, messages: [{ ts: '1.0', text: 'hi' }], has_more: false }
    const requests: { url: string; type: string | null; body: string; auth: string | null }[] = []
    const result = await run(
      cli({
        ...withToken(),
        fetch: async (request) => {
          requests.push({
            url: request.url,
            type: request.headers.get('content-type'),
            body: await request.text(),
            auth: request.headers.get('authorization'),
          })
          return Response.json(body)
        },
      }),
      ['conversations', 'history', 'C1', '--limit', '2', '--inclusive', '--json'],
    )
    expect(result.exitCode).toBeUndefined()
    expect(result.json()).toEqual(body)
    expect(requests).toEqual([
      {
        url: `${origin}/api/conversations.history`,
        type: 'application/x-www-form-urlencoded',
        body: 'channel=C1&inclusive=true&limit=2',
        auth: `Bearer ${accessToken}`,
      },
    ])
    expect(result.output).not.toContain(accessToken)
  })

  test('a Slack argument named like a CLI flag is sent under its Slack name', async () => {
    const bodies: string[] = []
    const result = await run(
      cli({
        ...withToken(),
        fetch: async (request) => {
          bodies.push(await request.text())
          return Response.json({ ok: true, job_id: 'J1' })
        },
      }),
      ['slackLists', 'download', 'start', '--list_id', 'L1', '--slack_format', 'json', '--json'],
    )
    expect(result.exitCode).toBeUndefined()
    expect(bodies).toEqual(['list_id=L1&format=json'])
  })

  test('time-range flags take ISO 8601 dates and times as well as Unix seconds', async () => {
    const bodies: URLSearchParams[] = []
    const target = cli({
      ...withToken(),
      fetch: async (request) => {
        bodies.push(new URLSearchParams(await request.text()))
        return Response.json({ ok: true, messages: [] })
      },
    })
    const history = (oldest: string, latest: string) =>
      run(target, ['conversations', 'history', 'C1', '--oldest', oldest, '--latest', latest])

    expect((await history('2026-09-24', '2026-09-24T21:10')).exitCode).toBeUndefined()
    expect((await history('2026-09-24T14:00-07:00', '1790284800.5')).exitCode).toBeUndefined()
    expect(bodies.map((body) => [body.get('oldest'), body.get('latest')])).toEqual([
      ['1790208000', '1790284200'],
      ['1790283600', '1790284800.5'],
    ])

    const invalid = await history('2026-02-30', '2026-09-24')
    expect(invalid.exitCode).toBe(1)
    expect(invalid.output).toContain('INVALID_ARGUMENT')
    expect(bodies).toHaveLength(2)
  })

  test('multi-line option values reach Slack intact', async () => {
    const bodies: URLSearchParams[] = []
    const text = 'line one\nline two\ttabbed'
    const blocks = '[\n  {"type": "divider"}\n]'
    const result = await run(
      cli({
        ...withToken(),
        fetch: async (request) => {
          bodies.push(new URLSearchParams(await request.text()))
          return Response.json({ ok: true, ts: '1.0' })
        },
      }),
      ['chat', 'postMessage', 'C1', '--text', text, '--blocks', blocks, '--json'],
    )
    expect(result.exitCode).toBeUndefined()
    expect(bodies.map((body) => [body.get('text'), body.get('blocks')])).toEqual([[text, blocks]])
  })

  test('a positional id with a control character fails without contacting Slack', async () => {
    const requests: string[] = []
    const fetch = (request: Request) => {
      requests.push(request.url)
      return Response.json({ ok: true })
    }
    const result = await run(cli({ ...withToken(), fetch }), [
      'conversations',
      'history',
      'C1\nC2',
      '--json',
    ])
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('VALIDATION_ERROR')
    expect(requests).toEqual([])
  })

  test('HTTP errors fail even when the body parses', async () => {
    const result = await run(
      cli({ ...withToken(), fetch: () => Response.json({ ok: true }, { status: 500 }) }),
      ['auth', 'test', '--json'],
    )
    expect(result.exitCode).toBe(3)
    expect(result.output).toContain('HTTP_ERROR')
    expect(result.output).toContain('HTTP 500')
  })

  test('rate limiting is retryable and carries Retry-After', async () => {
    const result = await run(
      cli({
        ...withToken(),
        fetch: () =>
          Response.json(
            { ok: false, error: 'ratelimited' },
            {
              status: 429,
              headers: { 'retry-after': '30' },
            },
          ),
      }),
      ['auth', 'test', '--full-output', '--json'],
    )
    expect(result.exitCode).toBe(3)
    expect(result.json().error).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      message: expect.stringContaining('retry after 30s') as unknown,
    })
  })

  test('a response body over 16 MiB is BAD_RESPONSE', async () => {
    const megabyte = new TextEncoder().encode(' '.repeat(1024 * 1024))
    let sent = 0
    const oversized = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent++ < 17) controller.enqueue(megabyte)
            else controller.close()
          },
        }),
      )
    const result = await run(cli({ ...withToken(), fetch: oversized }), ['auth', 'test', '--json'])
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('BAD_RESPONSE')
    expect(sent).toBeLessThanOrEqual(18)
  })

  test('rejects a token flag without contacting Slack', async () => {
    const calls: Request[] = []
    const result = await run(
      cli({
        fetch: (request) => {
          calls.push(request)
          return Response.json({ ok: true })
        },
      }),
      ['conversations', 'history', 'C1', '--token', 'xoxp-flag-not-a-secret'],
    )
    expect(result.exitCode).toBe(1)
    expect(calls).toHaveLength(0)
    expect(result.output).not.toContain('xoxp-flag-not-a-secret')
  })

  test('without credentials, methods fail AUTH_REQUIRED without contacting Slack', async () => {
    const calls: Request[] = []
    const result = await run(
      cli({
        fetch: (request) => {
          calls.push(request)
          return Response.json({ ok: true })
        },
      }),
      ['auth', 'test', '--json'],
    )
    expect(result.exitCode).toBe(4)
    expect(result.json()).toMatchObject({
      code: 'AUTH_REQUIRED',
      cta: { commands: [{ command: 'slack login' }] },
    })
    expect(calls).toHaveLength(0)
  })

  test('method help shows the rate tier, response fields, and argument examples', async () => {
    const history = await run(cli(), ['conversations', 'history', '--help'])
    expect(history.output).toContain('Rate limit: Tier 3 (50+ per minute)')
    expect(history.output).toContain(
      'Response fields: ok, messages, has_more, pin_count, response_metadata, latest',
    )
    expect(history.output).toMatch(/--limit <number> .*Default: 100\. Example: 20\./)
    const post = await run(cli(), ['chat', 'postMessage', '--help'])
    expect(post.output).toContain('Rate limit: Special; see the reference')
    expect(post.output).toMatch(/--text <string> .*Example: Hello world\./)
  })

  test('help for a method Slack retired says so and names the replacement', async () => {
    const upload = await run(cli(), ['files', 'upload', '--help'])
    expect(upload.output).toContain('method_deprecated')
    expect(upload.output).toContain('files getUploadURLExternal')
    expect(upload.output).toContain('files completeUploadExternal')
  })

  test('manifests mark methods that destroy data or access as destructive', async () => {
    const manifest = await run(cli(), ['--llms-full', '--format', 'json'])
    const destructive = (name: string) =>
      manifest.json().commands.find((command: { name: string }) => command.name === name)
        ?.destructive === true
    for (const name of [
      'chat delete',
      'conversations archive',
      'admin users remove',
      'auth revoke',
    ])
      expect(destructive(name), name).toBe(true)
    for (const name of ['chat postMessage', 'reactions remove', 'conversations history'])
      expect(destructive(name), name).toBe(false)
  })

  test('help documents the environment and never shows any of SLACK_TOKEN', async () => {
    let output = ''
    await cli().serve(['--help'], {
      env: { SLACK_TOKEN: 'xoxp-env-secret-wxyz', SLACK_WORKSPACE: 'T0123456789' },
      stdout: (text) => {
        output += text
      },
      stderr: (text) => {
        output += text
      },
      exit: () => {},
    })
    for (const name of ['SLACK_TOKEN', 'SLACK_WORKSPACE', 'SLACK_CLIENT_ID'])
      expect(output).toContain(name)
    expect(output).toMatch(/SLACK_TOKEN .*\(set\)/)
    expect(output).not.toMatch(/wxyz|secret/)
  })

  test('root help summarizes each family and points agents at per-family manifests', async () => {
    const help = await run(cli(), ['--help'])
    expect(help.output).toMatch(/^ {2}chat +Slack chat\.\* methods \(\d+\): /m)
    expect(help.output).toContain('slack <family> --llms-full')
    expect(help.output).toContain(
      'Unofficial Slack CLI, not affiliated with Slack (https://github.com/alleneubank/slack-cli)',
    )
  })

  test('help lists login, every family, and skills; no MCP', async () => {
    const help = await run(cli(), ['--help'])
    expect(help.exitCode).toBeUndefined()
    for (const command of ['login', 'logout', 'admin', 'conversations', 'slackLists', 'users'])
      expect(help.output).toMatch(new RegExp(`^  ${command} `, 'm'))
    expect(help.output).toContain('--workspace')
    expect(help.output).toMatch(/^ {2}skills /m)
    expect(help.output).not.toMatch(/mcp add|--mcp/)
    const version = await run(cli(), ['--version'])
    expect(version.output).toContain('0.0.0')
  })
})

describe('agent skill', () => {
  const skillDir = new URL('../skills/slack/', import.meta.url)
  const skillFile = new URL('SKILL.md', skillDir)
  /** Files SKILL.md links for agents to read on demand, relative to the skill directory. */
  const linkedFiles = () =>
    [...readFileSync(skillFile, 'utf8').matchAll(/\]\(([^)#:]+)\)/g)].map((match) => match[1]!)

  test('skills add installs the one hand-written skill', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'slack-cli-home-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    const saved = { HOME: process.env['HOME'], XDG_DATA_HOME: process.env['XDG_DATA_HOME'] }
    process.env['HOME'] = home
    process.env['XDG_DATA_HOME'] = path.join(home, '.local', 'share')
    try {
      const result = await run(cli(), ['skills', 'add', '--json'])
      expect(result.exitCode).toBeUndefined()
      const installed = result.output.slice(result.output.indexOf('{'))
      expect(JSON.parse(installed)).toMatchObject({
        skills: [path.join(home, '.agents', 'skills', 'slack')],
      })
      const written = readFileSync(
        path.join(home, '.agents', 'skills', 'slack', 'SKILL.md'),
        'utf8',
      )
      expect(written.trim()).toBe(readFileSync(skillFile, 'utf8').trim())
      for (const file of linkedFiles())
        expect(readFileSync(path.join(home, '.agents', 'skills', 'slack', file), 'utf8')).toBe(
          readFileSync(new URL(file, skillDir), 'utf8'),
        )
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
  })

  test('the skill is small and states the exit codes the CLI uses', () => {
    const skill = readFileSync(skillFile, 'utf8')
    expect(skill.length).toBeLessThan(6_000)
    expect(skill).toMatch(/^---\nname: slack\ndescription: /)
    expect(skill).toMatch(new RegExp(`^\\| ${EXIT_RETRYABLE} +\\| Retryable `, 'm'))
    expect(skill).toMatch(new RegExp(`^\\| ${EXIT_LOGIN} +\\| Needs login `, 'm'))
  })

  test('every file the skill links exists', () => {
    expect(linkedFiles().length).toBeGreaterThan(0)
    for (const file of linkedFiles()) expect(existsSync(new URL(file, skillDir))).toBe(true)
  })
})

describe('workspaces', () => {
  test('reads a single-workspace file from before multi-workspace support', async () => {
    const file = credentialsFile({ accessToken, refreshToken, tokenType: 'Bearer', teamId: 'T1' })
    const slack = fakeSlack({ live: new Set([accessToken]), refreshable: new Map() })
    const result = await run(cli({ file, fetch: slack.handler }), ['auth', 'test', '--json'])
    expect(result.exitCode).toBeUndefined()
    expect(result.json()).toMatchObject({ ok: true, team_id: 'T1' })
    expect(slack.calls[0]?.headers.get('authorization')).toBe(`Bearer ${accessToken}`)
  })

  test('login --paste reads the code from the terminal and stores a long-lived token', async () => {
    const file = credentialsFile()
    const exchanged: URLSearchParams[] = []
    const terminal: string[] = []
    const result = await run(
      cli({
        file,
        fetch: async (request) => {
          exchanged.push(new URLSearchParams(await request.text()))
          return Response.json({
            ok: true,
            access_token: 'xoxp-long-lived-not-a-secret',
            token_type: 'user',
            scope: 'channels:read,users:read',
            team: { id: 'T3', name: 'Remote' },
            authed_user: { id: 'U3' },
          })
        },
        oauth: {
          timeoutMs: 1_000,
          write: (text) => {
            terminal.push(text.startsWith('Authorize Slack:') ? 'authorize url' : text)
          },
          async openUrl() {},
          async waitForCode() {
            throw new Error('paste login must not listen on the loopback port')
          },
          async readPastedCode() {
            terminal.push('paste prompt')
            return 'pasted-code-not-a-secret'
          },
        },
      }),
      ['login', '--paste', '--json'],
    )
    expect(result.exitCode).toBeUndefined()
    expect(result.json()).toEqual({
      ok: true,
      teamId: 'T3',
      teamName: 'Remote',
      userId: 'U3',
      scopes: ['channels:read', 'users:read'],
    })
    expect(result.output).not.toMatch(/not-a-secret/)
    expect(terminal).toEqual(['authorize url', 'paste prompt'])
    expect(exchanged[0]?.get('code')).toBe('pasted-code-not-a-secret')
    expect(readCredentials(file).teams['T3']).toEqual({
      accessToken: 'xoxp-long-lived-not-a-secret',
      clientId: SLACK_OAUTH_CLIENT_ID,
      userId: 'U3',
      teamName: 'Remote',
      scopes: ['channels:read', 'users:read'],
    })
  })

  test('login adds a workspace, keeps the others, and makes it current', async () => {
    const file = credentialsFile(rotatingStore({ T1: { accessToken } }))
    const opened: string[] = []
    const result = await run(
      cli({
        file,
        fetch: async () =>
          Response.json({
            ok: true,
            access_token: 'xoxe.xoxp-second-not-a-secret',
            refresh_token: 'xoxe-second-not-a-secret',
            expires_in: 43_200,
            scope: 'channels:read,chat:write',
            team: { id: 'T2', name: 'Second' },
            authed_user: { id: 'U2' },
          }),
        oauth: {
          timeoutMs: 1_000,
          write: () => {},
          async openUrl(url) {
            opened.push(url)
          },
          async waitForCode() {
            return { code: 'auth-code-not-a-secret' }
          },
        },
      }),
      ['login', '--json'],
    )
    expect(result.exitCode).toBeUndefined()
    expect(result.json()).toEqual({
      ok: true,
      teamId: 'T2',
      teamName: 'Second',
      userId: 'U2',
      scopes: ['channels:read', 'chat:write'],
    })
    expect(result.output).not.toMatch(/not-a-secret/)
    expect(new URL(opened[0]!).searchParams.get('client_id')).toBe(SLACK_OAUTH_CLIENT_ID)
    expect(readCredentials(file)).toEqual({
      version: 1,
      currentTeamId: 'T2',
      teams: {
        T1: { accessToken },
        T2: {
          accessToken: 'xoxe.xoxp-second-not-a-secret',
          refreshToken: 'xoxe-second-not-a-secret',
          expiresAt: start + 12 * hour,
          clientId: SLACK_OAUTH_CLIENT_ID,
          userId: 'U2',
          teamName: 'Second',
          scopes: ['channels:read', 'chat:write'],
        },
      },
    })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('--workspace and SLACK_WORKSPACE select a workspace; SLACK_TOKEN overrides both', async () => {
    const file = credentialsFile(
      rotatingStore({ T1: { accessToken: 'xoxp-one' }, T2: { accessToken: 'xoxp-two' } }),
    )
    const used: (string | null)[] = []
    const fetch: Handler = (request) => {
      used.push(request.headers.get('authorization'))
      return Response.json({ ok: true })
    }
    await run(cli({ file, fetch }), ['auth', 'test'])
    await run(cli({ file, fetch }), ['auth', 'test', '--workspace', 'T2'])
    await run(cli({ file, fetch, env: { SLACK_WORKSPACE: 'T2' } }), ['auth', 'test'])
    await run(cli({ file, fetch, env: { SLACK_TOKEN: 'xoxp-env' } }), [
      'auth',
      'test',
      '--workspace',
      'T2',
    ])
    expect(used).toEqual([
      'Bearer xoxp-one',
      'Bearer xoxp-two',
      'Bearer xoxp-two',
      'Bearer xoxp-env',
    ])
    const unknown = await run(cli({ file, fetch }), ['auth', 'test', '--workspace', 'T9', '--json'])
    expect(unknown.exitCode).toBe(1)
    expect(unknown.json()).toMatchObject({
      code: 'UNKNOWN_WORKSPACE',
      message: expect.stringContaining('T1, T2') as unknown,
      cta: { commands: [{ command: 'slack workspaces list' }] },
    })
  })

  test('workspaces list shows every stored workspace without its tokens', async () => {
    const file = credentialsFile(
      rotatingStore(
        {
          T2: { accessToken: 'xoxp-two-not-a-secret' },
          T1: {
            accessToken,
            refreshToken,
            expiresAt: start + hour,
            userId: 'U1',
            teamName: 'Example',
            scopes: ['channels:read', 'chat:write'],
          },
        },
        'T1',
      ),
    )
    const listed = await run(cli({ file }), ['workspaces', 'list', '--json'])
    expect(listed.exitCode).toBeUndefined()
    expect(listed.json()).toEqual({
      current: 'T1',
      envToken: false,
      workspaces: [
        {
          teamId: 'T1',
          teamName: 'Example',
          userId: 'U1',
          current: true,
          rotating: true,
          expiresAt: new Date(start + hour).toISOString(),
          scopes: ['channels:read', 'chat:write'],
        },
        { teamId: 'T2', current: false, rotating: false },
      ],
    })
    expect(listed.output).not.toMatch(/not-a-secret/)

    const overridden = await run(
      cli({ file, env: { SLACK_WORKSPACE: 'T2', SLACK_TOKEN: 'xoxp-env-not-a-secret' } }),
      ['workspaces', 'list', '--json'],
    )
    expect(overridden.json()).toMatchObject({ current: 'T2', envToken: true })
    expect(overridden.output).not.toMatch(/not-a-secret/)
  })

  test('workspaces use makes a stored workspace current', async () => {
    const file = credentialsFile(
      rotatingStore({ T1: { accessToken: 'xoxp-one' }, T2: { accessToken: 'xoxp-two' } }),
    )
    const preview = await run(cli({ file }), ['workspaces', 'use', 'T2', '--dry-run', '--json'])
    expect(preview.json()).toMatchObject({ dryRun: true })
    expect(readCredentials(file).currentTeamId).toBe('T1')

    const used = await run(cli({ file }), ['workspaces', 'use', 'T2', '--json'])
    expect(used.json()).toEqual({ ok: true, currentTeamId: 'T2' })
    expect(readCredentials(file).currentTeamId).toBe('T2')

    const unknown = await run(cli({ file }), ['workspaces', 'use', 'T9', '--json'])
    expect(unknown.exitCode).toBe(1)
    expect(unknown.json()).toMatchObject({
      code: 'UNKNOWN_WORKSPACE',
      cta: { commands: [{ command: 'slack workspaces list' }] },
    })
    expect(readCredentials(file).currentTeamId).toBe('T2')
  })

  test('logout removes the current workspace and switches to the lowest remaining one', async () => {
    const file = credentialsFile(
      rotatingStore(
        {
          T3: { accessToken: 'xoxp-3' },
          T1: { accessToken: 'xoxp-1' },
          T2: { accessToken: 'xoxp-2' },
        },
        'T1',
      ),
    )
    const result = await run(cli({ file }), ['logout', '--json'])
    expect(result.json()).toEqual({ ok: true, removed: ['T1'], currentTeamId: 'T2' })
    expect(Object.keys(readCredentials(file).teams).toSorted()).toEqual(['T2', 'T3'])
    const all = await run(cli({ file }), ['logout', '--all', '--json'])
    expect(all.json()).toEqual({ ok: true, removed: ['T3', 'T2'] })
    expect(() => statSync(file)).toThrow(/ENOENT/)
  })

  test('an unreadable credentials file is CREDENTIALS_INVALID without echoing it', async () => {
    const file = credentialsFile()
    writeFileSync(file, `{"accessToken": "${accessToken}"`)
    const result = await run(cli({ file }), ['auth', 'test', '--json'])
    expect(result.exitCode).toBe(4)
    expect(result.json()).toMatchObject({
      code: 'CREDENTIALS_INVALID',
      cta: { commands: [{ command: 'slack logout --all' }, { command: 'slack login' }] },
    })
    expect(result.output).not.toContain(accessToken)
  })
})

function timeout(): never {
  throw new DOMException('The operation timed out.', 'TimeoutError')
}

function unavailable(): Response {
  return new Response('', { status: 503 })
}

function internalError(): Response {
  return Response.json({ ok: false, error: 'internal_error' })
}

describe('error contract', () => {
  const read = ['conversations', 'history', 'C1', '--json']
  const write = ['chat', 'postMessage', 'C1', '--text', 'hi', '--json']

  test.each([
    ['timed out', timeout, 'TIMEOUT'],
    ['got HTTP 503', unavailable, 'HTTP_ERROR'],
    ['got internal_error', internalError, 'internal_error'],
  ])('a read that %s is retryable and exits 3', async (_, fetch, code) => {
    const result = await run(cli({ ...withToken(), fetch }), read)
    expect(result.exitCode).toBe(3)
    expect(result.json()).toMatchObject({ code, retryable: true })
  })

  test.each([
    ['timed out', timeout, 'TIMEOUT'],
    ['got HTTP 503', unavailable, 'HTTP_ERROR'],
    ['got internal_error', internalError, 'internal_error'],
  ])('a write that %s is not retryable: it may have been applied', async (_, fetch, code) => {
    const result = await run(cli({ ...withToken(), fetch }), write)
    expect(result.exitCode).toBe(1)
    const error = result.json()
    expect(error).toMatchObject({ code, message: expect.stringContaining('may have been applied') })
    expect(error.retryable).toBeUndefined()
  })

  test('a rate-limited write is retryable: Slack rejected it', async () => {
    const result = await run(
      cli({
        ...withToken(),
        fetch: () => new Response('', { status: 429, headers: { 'retry-after': '5' } }),
      }),
      write,
    )
    expect(result.exitCode).toBe(3)
    expect(result.json()).toMatchObject({ code: 'RATE_LIMITED', retryable: true })
  })

  test('a rejected stored token exits 4 and suggests slack login', async () => {
    const file = credentialsFile(rotatingStore({ T1: { accessToken } }))
    const result = await run(
      cli({ file, fetch: () => Response.json({ ok: false, error: 'invalid_auth' }) }),
      read,
    )
    expect(result.exitCode).toBe(4)
    expect(result.json()).toMatchObject({
      code: 'invalid_auth',
      cta: { commands: [{ command: 'slack login' }] },
    })
  })

  test('a rejected SLACK_TOKEN says to fix or unset the override instead of logging in', async () => {
    const result = await run(
      cli({ ...withToken(), fetch: () => Response.json({ ok: false, error: 'invalid_auth' }) }),
      read,
    )
    expect(result.exitCode).toBe(1)
    expect(result.json()).toMatchObject({
      code: 'invalid_auth',
      message: expect.stringMatching(/fix or unset SLACK_TOKEN/),
    })
    expect(result.json().cta).toBeUndefined()
    expect(result.output).not.toContain(accessToken)
  })

  test.each([
    ['chat:write', 'slack login --write'],
    ['search:read', 'slack login'],
    ['users.profile:read', 'slack login'],
    ['usergroups:write', 'slack login --write'],
    ['admin,users.profile:read', 'slack login'],
  ])('a stored token missing %s suggests %s', async (needed, command) => {
    const file = credentialsFile(rotatingStore({ T1: { accessToken } }))
    const fetch = () => Response.json({ ok: false, error: 'missing_scope', needed })
    const result = await run(cli({ file, fetch }), read)
    expect(result.exitCode).toBe(4)
    expect(result.json()).toMatchObject({ code: 'missing_scope', cta: { commands: [{ command }] } })
  })

  test('a stored token missing a scope that login does not request says login cannot grant it', async () => {
    const file = credentialsFile(rotatingStore({ T1: { accessToken } }))
    const result = await run(
      cli({
        file,
        fetch: () => Response.json({ ok: false, error: 'missing_scope', needed: 'admin' }),
      }),
      read,
    )
    expect(result.exitCode).toBe(1)
    expect(result.json().cta).toBeUndefined()
    expect(result.json().message).toMatch(/slack login cannot grant it; set SLACK_TOKEN/)
  })

  test('a SLACK_TOKEN missing a scope says to fix or unset the override', async () => {
    const result = await run(
      cli({
        ...withToken(),
        fetch: () =>
          Response.json({ ok: false, error: 'missing_scope', needed: 'channels:history' }),
      }),
      read,
    )
    expect(result.exitCode).toBe(1)
    expect(result.json()).toMatchObject({
      code: 'missing_scope',
      message: expect.stringMatching(/fix or unset SLACK_TOKEN/),
    })
    expect(result.json().cta).toBeUndefined()
    expect(result.output).not.toContain(accessToken)
  })
})

describe('rotating tokens', () => {
  test('a token that expires soon is refreshed and persisted before the call', async () => {
    const file = credentialsFile(
      rotatingStore({
        T1: { accessToken, refreshToken, expiresAt: start + 60_000, clientId: 'cid-test' },
      }),
    )
    const slack = fakeSlack({
      live: new Set([accessToken]),
      refreshable: new Map([[refreshToken, accessToken]]),
    })
    const result = await run(cli({ file, fetch: slack.handler }), ['auth', 'test', '--json'])
    expect(result.exitCode).toBe(undefined)
    const [refresh] = slack.refreshCalls()
    const sent = new URLSearchParams(await refresh!.text())
    expect(Object.fromEntries(sent)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'cid-test',
    })
    expect(slack.calls.at(-1)?.headers.get('authorization')).toBe('Bearer xoxe.xoxp-renewed-1')
    expect(readCredentials(file).teams['T1']).toEqual({
      accessToken: 'xoxe.xoxp-renewed-1',
      refreshToken: 'xoxe-renewed-1',
      expiresAt: start + 12 * hour,
      clientId: 'cid-test',
      teamName: 'Example',
      scopes: ['channels:read', 'chat:write'],
    })
    expect(result.output).not.toMatch(/xoxe/)
  })

  test('token_expired refreshes once and retries once', async () => {
    const file = credentialsFile({ accessToken, refreshToken, teamId: 'T1' })
    const slack = fakeSlack({
      live: new Set(),
      refreshable: new Map([[refreshToken, accessToken]]),
    })
    const result = await run(cli({ file, fetch: slack.handler }), ['auth', 'test', '--json'])
    expect(result.exitCode).toBeUndefined()
    expect(slack.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/auth.test',
      '/api/oauth.v2.user.access',
      '/api/auth.test',
    ])
    expect(readCredentials(file)).toMatchObject({
      version: 1,
      currentTeamId: 'T1',
      teams: {
        T1: {
          accessToken: 'xoxe.xoxp-renewed-1',
          refreshToken: 'xoxe-renewed-1',
          clientId: SLACK_OAUTH_CLIENT_ID,
        },
      },
    })
  })

  test('concurrent commands refresh once and both use the new token', async () => {
    const file = credentialsFile(
      rotatingStore({ T1: { accessToken, refreshToken, expiresAt: start - hour } }),
    )
    const slack = fakeSlack({
      live: new Set(),
      refreshable: new Map([[refreshToken, accessToken]]),
    })
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        run(cli({ file, fetch: slack.handler }), ['auth', 'test', '--json']),
      ),
    )
    expect(results.map((result) => result.exitCode)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(slack.refreshCalls()).toHaveLength(1)
    expect(readCredentials(file).teams['T1']?.refreshToken).toBe('xoxe-renewed-1')
  })

  test('logout --all waits for an in-flight refresh and leaves nothing stored', async () => {
    const file = credentialsFile(
      rotatingStore({ T1: { accessToken, refreshToken, expiresAt: start - hour } }),
    )
    const slack = fakeSlack({
      live: new Set(),
      refreshable: new Map([[refreshToken, accessToken]]),
    })
    let refreshing!: () => void
    const refreshStarted = new Promise<void>((resolve) => {
      refreshing = resolve
    })
    let finishRefresh!: () => void
    const refreshMayFinish = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const slowRefresh: Handler = async (request) => {
      if (request.url.endsWith('/oauth.v2.user.access')) {
        refreshing()
        await refreshMayFinish
      }
      return slack.handler(request)
    }

    const command = run(cli({ file, fetch: slowRefresh }), ['auth', 'test'])
    await refreshStarted
    const logout = run(cli({ file }), ['logout', '--all', '--json'])
    await until(() => !existsSync(file), 200)
    finishRefresh()
    await Promise.all([command, logout])
    expect(existsSync(file)).toBe(false)
  })

  test('a failed refresh is AUTH_EXPIRED and does not print the refresh token', async () => {
    const file = credentialsFile(
      rotatingStore({ T1: { accessToken, refreshToken, expiresAt: start - hour } }),
    )
    const slack = fakeSlack({ live: new Set(), refreshable: new Map() })
    const result = await run(cli({ file, fetch: slack.handler }), ['auth', 'test', '--json'])
    expect(result.exitCode).toBe(4)
    expect(result.json()).toMatchObject({
      code: 'AUTH_EXPIRED',
      cta: { commands: [{ command: 'slack login' }] },
    })
    expect(result.output).toContain('invalid_refresh_token')
    expect(result.output).not.toContain(refreshToken)
  })
})
