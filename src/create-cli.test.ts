import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from 'vitest'

import { createCli, type OauthHost } from './create-cli.js'
import { fileCredentialStore, type CredentialsFile } from './credentials.js'
import { EXIT_LOGIN, EXIT_RETRYABLE } from './errors.js'
import { listenForLoopbackCode, OAUTH_LOOPBACK_PORT } from './oauth.js'
import { SLACK_OAUTH_CLIENT_ID } from './slack-app.js'

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
    configurationToken?: string
  } = {},
) {
  const { configurationToken } = options
  return createCli({
    version: '0.0.0',
    apiOrigin: origin,
    env: options.env ?? {},
    credentials: fileCredentialStore(options.file ?? credentialsFile()),
    fetch: options.fetch ?? (() => Response.json({ ok: true })),
    now: options.now ?? (() => start),
    ...(options.oauth ? { oauth: options.oauth } : undefined),
    ...(configurationToken === undefined
      ? undefined
      : { readConfigurationToken: async () => `${configurationToken}\n` }),
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

  describe('message links', () => {
    const messageLink = 'https://example.slack.com/archives/C0123456789/p1789757627925439'
    const replyLink = `${messageLink}?thread_ts=1789757600.000100&cid=C0123456789`

    function recorder() {
      const requests: { method: string; body: URLSearchParams }[] = []
      const target = cli({
        ...withToken(),
        fetch: async (request) => {
          const method = new URL(request.url).pathname.replace('/api/', '')
          requests.push({ method, body: new URLSearchParams(await request.text()) })
          return Response.json({ ok: true })
        },
      })
      const sent = () =>
        requests.map(({ method, body }) => [method, Object.fromEntries(body.entries())])
      return { target, sent }
    }

    test('a link names the channel and message in place of the two ids', async () => {
      const { target, sent } = recorder()
      expect((await run(target, ['chat', 'getPermalink', messageLink])).exitCode).toBeUndefined()
      expect((await run(target, ['chat', 'delete', replyLink])).exitCode).toBeUndefined()
      expect(
        (await run(target, ['chat', 'getPermalink', 'C1', '1789757627.925439'])).exitCode,
      ).toBeUndefined()
      expect(sent()).toEqual([
        ['chat.getPermalink', { channel: 'C0123456789', message_ts: '1789757627.925439' }],
        ['chat.delete', { channel: 'C0123456789', ts: '1789757627.925439' }],
        ['chat.getPermalink', { channel: 'C1', message_ts: '1789757627.925439' }],
      ])
    })

    test('replies read the thread a reply link names', async () => {
      const { target, sent } = recorder()
      expect((await run(target, ['conversations', 'replies', replyLink])).exitCode).toBeUndefined()
      expect(
        (await run(target, ['conversations', 'replies', messageLink])).exitCode,
      ).toBeUndefined()
      expect(sent()).toEqual([
        ['conversations.replies', { channel: 'C0123456789', ts: '1789757600.000100' }],
        ['conversations.replies', { channel: 'C0123456789', ts: '1789757627.925439' }],
      ])
    })

    test('history with a link reads that message unless a range flag is given', async () => {
      const { target, sent } = recorder()
      expect(
        (await run(target, ['conversations', 'history', messageLink])).exitCode,
      ).toBeUndefined()
      expect(
        (await run(target, ['conversations', 'history', messageLink, '--limit', '5'])).exitCode,
      ).toBeUndefined()
      expect(sent()).toEqual([
        [
          'conversations.history',
          {
            channel: 'C0123456789',
            oldest: '1789757627.925439',
            latest: '1789757627.925439',
            inclusive: 'true',
            limit: '1',
          },
        ],
        ['conversations.history', { channel: 'C0123456789', limit: '5' }],
      ])
    })

    test('a malformed link or a missing ts fails before any request', async () => {
      const { target, sent } = recorder()
      const invalid = [
        ['chat', 'delete', 'https://example.com/archives/C0123456789/p1789757627925439'],
        ['chat', 'delete', 'https://example.slack.com/archives/C0123456789/1789757627925439'],
        ['conversations', 'replies', 'https://example.slack.com/archives/C0123456789/p17897'],
        ['conversations', 'replies', `${messageLink}?thread_ts=yesterday`],
        ['conversations', 'history', 'example.slack.com/archives/C0123456789'],
        ['chat', 'delete', 'C0123456789'],
        ['chat', 'delete', messageLink, '1789757627.925439'],
      ]
      for (const argv of invalid) {
        const result = await run(target, argv)
        expect(result.exitCode).toBe(1)
        expect(result.output).toContain('INVALID_ARGUMENT')
      }
      expect((await run(target, ['chat', 'delete', 'https://x.slack.com/'])).output).toContain(
        'https://<workspace>.slack.com/archives/<channel>/p<digits>',
      )
      expect(sent()).toEqual([])
    })
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

function noSlackCall(): Response {
  throw new Error('no Slack call')
}

describe('credentials in responses', () => {
  const secrets = {
    client_secret: 'client-secret-not-a-secret',
    signing_secret: 'signing-secret-not-a-secret',
    verification_token: 'verification-not-a-secret',
    access_token: 'xoxp-issued-not-a-secret',
    refresh_token: 'xoxe-1-refresh-not-a-secret',
  }

  test('no command prints a token or secret Slack returns, at any depth', async () => {
    const answers: Record<string, unknown> = {
      'apps.manifest.create': {
        ok: true,
        app_id: 'A0NEW',
        credentials: {
          client_id: '1111111111.2222222222',
          client_secret: secrets.client_secret,
          signing_secret: secrets.signing_secret,
          verification_token: secrets.verification_token,
        },
      },
      'apps.auth.external.get': {
        ok: true,
        token_type: 'user',
        external_tokens: [
          { id: 'U1', access_token: secrets.access_token, refresh_token: secrets.refresh_token },
        ],
      },
    }
    const fetch = (request: Request) =>
      Response.json(answers[new URL(request.url).pathname.slice(5)])
    const created = await run(cli({ ...withToken(), fetch }), [
      'apps',
      'manifest',
      'create',
      '--manifest',
      '{}',
      '--json',
    ])
    const external = await run(cli({ ...withToken(), fetch }), [
      'apps',
      'auth',
      'external',
      'get',
      '--external_token_id',
      'Et1',
      '--json',
    ])
    for (const result of [created, external])
      for (const secret of Object.values(secrets)) expect(result.output).not.toContain(secret)
    expect(created.json()).toMatchObject({
      app_id: 'A0NEW',
      credentials: { client_id: '1111111111.2222222222', client_secret: '[redacted]' },
      redacted: [
        'credentials.client_secret',
        'credentials.signing_secret',
        'credentials.verification_token',
      ],
    })
    expect(external.json()).toMatchObject({
      token_type: 'user',
      external_tokens: [{ id: 'U1', access_token: '[redacted]' }],
      redacted: ['external_tokens[0].access_token', 'external_tokens[0].refresh_token'],
    })
  })

  test('methods whose result is a credential are not commands', async () => {
    for (const argv of [
      ['tooling', 'tokens', 'rotate', '--refresh_token', 'xoxe-1-not-a-secret'],
      ['oauth', 'v2', 'access', '--code', 'c'],
      ['openid', 'connect', 'token', '--code', 'c'],
    ]) {
      const result = await run(cli({ ...withToken(), fetch: noSlackCall }), [...argv, '--json'])
      expect(result.json()).toMatchObject({ code: 'COMMAND_NOT_FOUND' })
    }
    const openid = await run(cli(), ['openid', 'connect', '--help'])
    expect(openid.output).toContain('userInfo')
  })

  test('apps manifest create help points to slack app create', async () => {
    const result = await run(cli(), ['apps', 'manifest', 'create', '--help'])
    expect(result.output).toContain('use slack app create')
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
          async receiveCode() {
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
      clientId: SLACK_OAUTH_CLIENT_ID,
      app: 'shared',
      scopes: ['channels:read', 'users:read'],
    })
    expect(result.output).not.toMatch(/not-a-secret/)
    expect(terminal).toEqual(['App: shared\n', 'authorize url', 'paste prompt'])
    expect(exchanged[0]?.get('code')).toBe('pasted-code-not-a-secret')
    expect(readCredentials(file).teams['T3']).toEqual({
      accessToken: 'xoxp-long-lived-not-a-secret',
      clientId: SLACK_OAUTH_CLIENT_ID,
      userId: 'U3',
      teamName: 'Remote',
      scopes: ['channels:read', 'users:read'],
    })
  })

  test('a login while another holds the loopback port fails before the browser opens', async () => {
    const port = OAUTH_LOOPBACK_PORT + 10_002
    const waiting = await listenForLoopbackCode({
      state: 'loopback.waiting',
      timeoutMs: 1_000,
      port,
    })
    const file = credentialsFile()
    const opened: string[] = []
    const result = await run(
      cli({
        file,
        fetch: () => {
          throw new Error('no token exchange without a code')
        },
        oauth: {
          timeoutMs: 1_000,
          write: (text) => opened.push(text),
          async openUrl(url) {
            opened.push(url)
          },
          receiveCode: (input) => listenForLoopbackCode({ ...input, port }),
          async readPastedCode() {
            throw new Error('not a paste login')
          },
        },
      }),
      ['login', '--json'],
    )
    expect(result.exitCode).toBe(1)
    expect(result.json()).toMatchObject({
      code: 'LOGIN_IN_PROGRESS',
      message: expect.stringContaining('slack login --paste') as unknown,
    })
    expect(opened.join('')).not.toContain('Authorize Slack')
    expect(existsSync(file)).toBe(false)

    await fetch(`http://127.0.0.1:${port}/callback?state=loopback.waiting&code=waiting-code`)
    await expect(waiting.code()).resolves.toBe('waiting-code')
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
          async receiveCode() {
            return { code: async () => 'auth-code-not-a-secret', close() {} }
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
      clientId: SLACK_OAUTH_CLIENT_ID,
      app: 'shared',
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

  test('login signs in through --client-id, then SLACK_CLIENT_ID, then the stored app, then the shared app', async () => {
    const own = '1111111111.2222222222'
    const stored = rotatingStore({
      T1: { accessToken: 'xoxp-one-not-a-secret', clientId: own, teamName: 'Own' },
      T2: { accessToken: 'xoxp-two-not-a-secret', clientId: SLACK_OAUTH_CLIENT_ID },
    })
    const login = async (argv: string[], env: Record<string, string> = {}) => {
      const file = credentialsFile(stored)
      const opened: URL[] = []
      const terminal: string[] = []
      const result = await run(
        cli({
          file,
          env,
          fetch: async () =>
            Response.json({
              ok: true,
              access_token: 'xoxp-issued-not-a-secret',
              team: { id: 'T1', name: 'Own' },
              authed_user: { id: 'U1' },
            }),
          oauth: {
            timeoutMs: 1_000,
            write: (text) => {
              if (!text.startsWith('Authorize Slack:')) terminal.push(text)
            },
            async openUrl(url) {
              opened.push(new URL(url))
            },
            async receiveCode() {
              return { code: async () => 'auth-code-not-a-secret', close() {} }
            },
            async readPastedCode() {
              throw new Error('not a paste login')
            },
          },
        }),
        ['login', ...argv, '--json'],
      )
      return {
        result,
        clientId: opened[0]?.searchParams.get('client_id'),
        team: opened[0]?.searchParams.get('team'),
        terminal,
        stored: readCredentials(file).teams['T1'],
      }
    }

    // Re-login of the current workspace keeps its own app without a variable.
    const relogin = await login(['--write'])
    expect(relogin.clientId).toBe(own)
    expect(relogin.team).toBeNull()
    expect(relogin.terminal).toEqual([`App: own app ${own} (stored for T1 Own)\n`])
    expect(relogin.stored?.clientId).toBe(own)
    expect(relogin.result.json()).toMatchObject({ teamId: 'T1', clientId: own, app: 'own' })

    const named = await login(['--workspace', 'T2'])
    expect([named.clientId, named.team]).toEqual([SLACK_OAUTH_CLIENT_ID, 'T2'])
    // Slack signs in T1 although T2 was named, as when the user switches workspace on the consent page.
    expect(named.terminal).toEqual([
      'App: shared (stored for T2)\n',
      `T1 now signs in through the shared app instead of own app ${own}\n`,
    ])

    const unstored = await login(['--workspace', 'T9'])
    expect([unstored.clientId, unstored.team]).toEqual([SLACK_OAUTH_CLIENT_ID, 'T9'])

    const variable = await login([], { SLACK_CLIENT_ID: '3333333333.4444444444' })
    expect(variable.clientId).toBe('3333333333.4444444444')
    expect(variable.stored?.clientId).toBe('3333333333.4444444444')
    expect(variable.terminal).toEqual([
      'App: own app 3333333333.4444444444 (from SLACK_CLIENT_ID)\n',
      `T1 now signs in through own app 3333333333.4444444444 instead of own app ${own}\n`,
    ])

    const flag = await login(['--client-id', 'shared'], {
      SLACK_CLIENT_ID: '3333333333.4444444444',
    })
    expect(flag.clientId).toBe(SLACK_OAUTH_CLIENT_ID)
    expect(flag.terminal[0]).toBe('App: shared (from --client-id)\n')
    expect(flag.result.json()).toMatchObject({ clientId: SLACK_OAUTH_CLIENT_ID, app: 'shared' })

    for (const invalid of [
      await login(['--client-id', 'A0123ABCD']),
      await login([], { SLACK_CLIENT_ID: 'A0123ABCD' }),
    ]) {
      expect(invalid.result.exitCode).toBe(1)
      expect(invalid.result.output).toContain('INVALID_ARGUMENT')
      expect(invalid.clientId).toBeUndefined()
      expect(invalid.stored?.clientId).toBe(own)
    }
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
          T2: { accessToken: 'xoxp-two-not-a-secret', clientId: SLACK_OAUTH_CLIENT_ID },
          T1: {
            accessToken,
            refreshToken,
            expiresAt: start + hour,
            clientId: '1111111111.2222222222',
            userId: 'U1',
            teamName: 'Example',
            scopes: ['channels:read', 'chat:write'],
          },
        },
        'T1',
      ),
    )
    const listed = await run(cli({ file }), ['workspaces', 'list', '--scopes', '--json'])
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
          clientId: '1111111111.2222222222',
          app: 'own',
          rotating: true,
          expiresAt: new Date(start + hour).toISOString(),
          scopes: ['channels:read', 'chat:write'],
        },
        {
          teamId: 'T2',
          current: false,
          clientId: SLACK_OAUTH_CLIENT_ID,
          app: 'shared',
          rotating: false,
        },
      ],
    })
    expect(listed.output).not.toMatch(/not-a-secret/)

    const overridden = await run(
      cli({ file, env: { SLACK_WORKSPACE: 'T2', SLACK_TOKEN: 'xoxp-env-not-a-secret' } }),
      ['workspaces', 'list', '--json'],
    )
    expect(overridden.json()).toMatchObject({ current: 'T2', envToken: true })
    expect(overridden.output).not.toMatch(/not-a-secret/)
    expect(overridden.output).not.toContain('chat:write')
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

function outDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'slack-cli-out-'))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

describe('files download', () => {
  const fileUrl = 'https://files.slack.com/files-pri/T1-F1/download/trace.png'
  const slackFile = {
    id: 'F1',
    name: 'trace.png',
    mimetype: 'image/png',
    size: 4,
    url_private_download: fileUrl,
  }

  /** Answers files.info and a one-message history; `fileHost` answers every other URL. */
  function fakeFiles(fileHost: Handler, attached: unknown[] = [slackFile], info = slackFile) {
    const requests: Request[] = []
    const handler: Handler = (request) => {
      requests.push(request)
      if (request.url === `${origin}/api/files.info`) return Response.json({ ok: true, file: info })
      if (request.url === `${origin}/api/conversations.history`)
        return Response.json({
          ok: true,
          messages: [{ ts: '1789757627.925439', files: attached }],
        })
      return fileHost(request)
    }
    return { handler, requests }
  }

  test('a redirect off *.slack.com is refused and never receives the token', async () => {
    const out = outDirectory()
    const slack = fakeFiles(
      () => new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/x' } }),
    )
    const result = await run(cli({ ...withToken(), fetch: slack.handler }), [
      'files',
      'download',
      'F1',
      '--out',
      out,
      '--json',
    ])
    expect(result.exitCode).toBe(1)
    expect(result.json()).toMatchObject({ code: 'UNTRUSTED_URL' })
    expect(slack.requests.map((request) => new URL(request.url).host)).not.toContain(
      'cdn.example.com',
    )
    expect(result.output).not.toContain(accessToken)
    expect(existsSync(path.join(out, 'trace.png'))).toBe(false)
  })

  test('a file whose id and name would leave --out is refused and nothing is written', async () => {
    const out = outDirectory()
    const inner = path.join(out, 'inner')
    mkdirSync(inner)
    const slack = fakeFiles(() => new Response('PNG!'), [], {
      ...slackFile,
      id: '../escaped',
      name: '..',
    })
    const result = await run(cli({ ...withToken(), fetch: slack.handler }), [
      'files',
      'download',
      'F1',
      '--out',
      inner,
      '--json',
    ])
    expect(result.json()).toMatchObject({ code: 'FILE_UNAVAILABLE' })
    expect(readdirSync(out)).toEqual(['inner'])
    expect(readdirSync(inner)).toEqual([])
  })

  test("Slack's sign-in page in place of the file is FILE_ACCESS_DENIED and saves nothing", async () => {
    const out = outDirectory()
    const slack = fakeFiles(
      () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }),
    )
    const result = await run(cli({ ...withToken(), fetch: slack.handler }), [
      'files',
      'download',
      'F1',
      '--out',
      out,
      '--json',
    ])
    expect(result.json()).toMatchObject({ code: 'FILE_ACCESS_DENIED' })
    expect(existsSync(path.join(out, 'trace.png'))).toBe(false)
  })

  test('a Slack Connect file stub on a linked message is downloaded through files.info', async () => {
    const out = outDirectory()
    const slack = fakeFiles(
      (request) =>
        request.url === fileUrl && request.headers.get('authorization') === `Bearer ${accessToken}`
          ? new Response('PNG!', { headers: { 'content-type': 'image/png' } })
          : new Response('unexpected', { status: 404 }),
      [{ id: 'F1', file_access: 'check_file_info' }],
    )
    const result = await run(cli({ ...withToken(), fetch: slack.handler }), [
      'files',
      'download',
      'https://acme.slack.com/archives/C1/p1789757627925439',
      '--out',
      out,
      '--json',
    ])
    expect(result.json()).toMatchObject({
      ok: true,
      files: [{ id: 'F1', name: 'trace.png', path: path.join(out, 'trace.png') }],
    })
    expect(readFileSync(path.join(out, 'trace.png'), 'utf8')).toBe('PNG!')
  })
})

/** Browser side of a loopback login whose code comes from `code`. */
function consentHost(code: () => Promise<string>, terminal: string[] = []): OauthHost {
  return {
    timeoutMs: 1_000,
    write: (text) => {
      if (!text.startsWith('Authorize Slack:')) terminal.push(text)
    },
    async openUrl() {},
    receiveCode: async () => ({ code, close() {} }),
    async readPastedCode() {
      throw new Error('not a paste login')
    },
  }
}

describe('app create', () => {
  const configurationToken = 'xoxe.xoxp-1-configuration-not-a-secret'
  const appSecrets = {
    client_secret: 'client-secret-not-a-secret',
    verification_token: 'verification-not-a-secret',
    signing_secret: 'signing-secret-not-a-secret',
  }
  const created = {
    ok: true,
    app_id: 'A0OWNAPP',
    credentials: { client_id: '1111111111.2222222222', ...appSecrets },
    oauth_authorize_url: 'https://slack.com/oauth/v2/authorize?client_id=1111111111.2222222222',
  }

  test('creates the app from the manifest, signs in through it, and keeps none of its secrets', async () => {
    const file = credentialsFile(
      rotatingStore({ T1: { accessToken: 'xoxp-old', clientId: SLACK_OAUTH_CLIENT_ID } }),
    )
    const manifestRequests: { auth: string | null; manifest: string | null }[] = []
    const terminal: string[] = []
    const result = await run(
      cli({
        file,
        configurationToken,
        fetch: async (request) => {
          const body = new URLSearchParams(await request.text())
          if (new URL(request.url).pathname === '/api/apps.manifest.create') {
            manifestRequests.push({
              auth: request.headers.get('authorization'),
              manifest: body.get('manifest'),
            })
            return Response.json(created)
          }
          expect(body.get('client_id')).toBe('1111111111.2222222222')
          return Response.json({
            ok: true,
            access_token: 'xoxp-own-not-a-secret',
            scope: 'channels:history',
            team: { id: 'T1', name: 'Own' },
            authed_user: { id: 'U1' },
          })
        },
        oauth: consentHost(async () => 'auth-code-not-a-secret', terminal),
      }),
      ['app', 'create', '--json'],
    )
    expect(result.exitCode).toBeUndefined()
    expect(result.json()).toEqual({
      ok: true,
      appId: 'A0OWNAPP',
      teamId: 'T1',
      teamName: 'Own',
      userId: 'U1',
      clientId: '1111111111.2222222222',
      app: 'own',
      scopes: ['channels:history'],
    })
    expect(manifestRequests).toEqual([
      {
        auth: `Bearer ${configurationToken}`,
        manifest: readFileSync(new URL('../slack-app-manifest.json', import.meta.url), 'utf8'),
      },
    ])
    expect(terminal).toEqual([
      'Created app A0OWNAPP (client id 1111111111.2222222222).\n',
      'App: own app 1111111111.2222222222\n',
      'T1 now signs in through own app 1111111111.2222222222 instead of the shared app\n',
      'If this workspace also signed in through the shared app, it stays authorized there; remove it under Manage apps in Slack.\n',
    ])
    const stored = readFileSync(file, 'utf8')
    expect(readCredentials(file).teams['T1']).toMatchObject({
      clientId: '1111111111.2222222222',
      appId: 'A0OWNAPP',
    })
    for (const secret of [configurationToken, ...Object.values(appSecrets)]) {
      expect(result.output).not.toContain(secret)
      expect(terminal.join('')).not.toContain(secret)
      expect(stored).not.toContain(secret)
    }
  })

  test('a sign-in that fails after the app exists points at login through that app', async () => {
    let creates = 0
    const result = await run(
      cli({
        configurationToken,
        fetch: () => {
          creates += 1
          return Response.json(created)
        },
        oauth: consentHost(async () => {
          throw new Error('Timed out waiting for the Slack authorization')
        }),
      }),
      ['app', 'create', '--write', '--json'],
    )
    expect(result.exitCode).toBe(1)
    expect(creates).toBe(1)
    expect(result.json()).toMatchObject({
      code: 'SIGN_IN_FAILED',
      message: expect.stringContaining('Created app A0OWNAPP') as unknown,
      cta: { commands: [{ command: 'slack login --client-id 1111111111.2222222222 --write' }] },
    })
    expect(result.output).not.toContain(configurationToken)
  })

  test('Slack rejections name what to fix and never ask for login', async () => {
    const rejected = async (body: unknown) =>
      run(cli({ configurationToken, fetch: () => Response.json(body) }), [
        'app',
        'create',
        '--json',
      ])

    const expired = await rejected({ ok: false, error: 'token_expired' })
    expect(expired.exitCode).toBe(1)
    expect(expired.json().message).toContain('generate a new app configuration token')
    expect(expired.json().cta).toBeUndefined()

    const invalid = await rejected({
      ok: false,
      error: 'invalid_manifest',
      errors: [{ message: 'Invalid scope', pointer: '/oauth_config/scopes/user/0' }],
    })
    expect(invalid.exitCode).toBe(1)
    expect(invalid.json()).toMatchObject({
      code: 'invalid_manifest',
      message: expect.stringContaining('/oauth_config/scopes/user/0: Invalid scope') as unknown,
    })
    // The request may have reached Slack, so the app may exist: finish it rather than create another.
    const lost = await run(
      cli({
        configurationToken,
        fetch: () => {
          throw new TypeError('fetch failed')
        },
      }),
      ['app', 'create', '--paste', '--json'],
    )
    expect(lost.exitCode).toBe(1)
    expect(lost.json()).toMatchObject({
      code: 'NETWORK',
      message: expect.stringContaining(
        'finish with slack login --client-id <its Client ID> --paste instead of creating another',
      ) as unknown,
    })

    // Slack answered 200 and the body was cut off: the app most likely exists.
    const cut = await run(
      cli({
        configurationToken,
        fetch: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"ok":true,"app_id":'))
                controller.error(new TypeError('terminated'))
              },
            }),
          ),
      }),
      ['app', 'create', '--json'],
    )
    expect(cut.exitCode).toBe(1)
    expect(cut.json()).toMatchObject({
      code: 'NETWORK',
      message: expect.stringContaining('finish with slack login --client-id') as unknown,
    })

    for (const result of [expired, invalid, lost, cut])
      expect(result.output).not.toContain(configurationToken)
  })
})

/** Slack's side: apps.manifest.export answers `manifest`, apps.manifest.update stores it. */
function slackApps(manifest: Record<string, unknown>) {
  const calls: { method: string; auth: string | null; body: URLSearchParams }[] = []
  let stored = manifest
  const fetch = async (request: Request) => {
    const method = new URL(request.url).pathname.slice(5)
    const body = new URLSearchParams(await request.text())
    calls.push({ method, auth: request.headers.get('authorization'), body })
    if (method === 'apps.manifest.export') return Response.json({ ok: true, manifest: stored })
    if (method === 'apps.manifest.update') {
      stored = JSON.parse(body.get('manifest')!) as Record<string, unknown>
      return Response.json({ ok: true, app_id: body.get('app_id'), permissions_updated: true })
    }
    throw new Error(`unexpected ${method}`)
  }
  return { calls, fetch, current: () => stored }
}

function noCallWithoutAppId(): Response {
  throw new Error('no Slack call without an app id')
}

function issueToken(): Response {
  return Response.json({
    ok: true,
    access_token: 'xoxp-new',
    team: { id: 'T1' },
    authed_user: { id: 'U1' },
  })
}

describe('app update', () => {
  const configurationToken = 'xoxe.xoxp-1-configuration-not-a-secret'
  const bundled = JSON.parse(
    readFileSync(new URL('../slack-app-manifest.json', import.meta.url), 'utf8'),
  ) as { oauth_config: { scopes: { user: string[] }; redirect_urls: string[] } }
  const ownApp = { accessToken, clientId: '1111111111.2222222222', appId: 'A0OWNAPP' }

  test('adds the missing user scopes and keeps the rest of the app; a second run changes nothing', async () => {
    const file = credentialsFile(rotatingStore({ T1: ownApp }))
    const behind = {
      display_information: { name: 'Renamed by the admin' },
      oauth_config: {
        redirect_urls: bundled.oauth_config.redirect_urls,
        pkce_enabled: true,
        scopes: {
          user: [
            ...bundled.oauth_config.scopes.user.filter((scope) => !scope.startsWith('lists:')),
            'admin',
          ],
          bot: ['chat:write'],
        },
      },
      settings: { org_deploy_enabled: false },
    }
    const slack = slackApps(behind)
    const terminal: string[] = []
    const oauth = consentHost(async () => 'unused', terminal)
    const first = await run(cli({ file, configurationToken, fetch: slack.fetch, oauth }), [
      'app',
      'update',
      '--json',
    ])
    expect(first.exitCode).toBeUndefined()
    expect(first.json()).toEqual({
      ok: true,
      appId: 'A0OWNAPP',
      changed: true,
      addedScopes: ['lists:read', 'lists:write'],
    })
    expect(terminal).toEqual([
      'Added 2 user scopes to app A0OWNAPP: lists:read, lists:write\nRun slack login --write to grant them.\n',
    ])
    expect(slack.calls.map((call) => [call.method, call.auth, call.body.get('app_id')])).toEqual([
      ['apps.manifest.export', `Bearer ${configurationToken}`, 'A0OWNAPP'],
      ['apps.manifest.update', `Bearer ${configurationToken}`, 'A0OWNAPP'],
    ])
    expect(slack.current()).toMatchObject({
      display_information: { name: 'Renamed by the admin' },
      settings: { org_deploy_enabled: false },
      oauth_config: { scopes: { bot: ['chat:write'] } },
    })
    const scopes = (slack.current() as typeof behind).oauth_config.scopes.user
    expect(scopes.toSorted()).toEqual([...bundled.oauth_config.scopes.user, 'admin'].toSorted())

    const second = await run(cli({ file, configurationToken, fetch: slack.fetch, oauth }), [
      'app',
      'update',
      '--json',
    ])
    expect(second.json()).toEqual({ ok: true, appId: 'A0OWNAPP', changed: false, addedScopes: [] })
    expect(slack.calls.map((call) => call.method)).toEqual([
      'apps.manifest.export',
      'apps.manifest.update',
      'apps.manifest.export',
    ])
    expect(first.output + second.output).not.toContain(configurationToken)
  })

  test('a manifest whose export came back redacted is not written back', async () => {
    const file = credentialsFile(rotatingStore({ T1: ownApp }))
    const slack = slackApps({ oauth_config: { scopes: { user: [] } } })
    const redacted = async (request: Request) => {
      const answer = await slack.fetch(request)
      const body = (await answer.json()) as Record<string, unknown>
      return Response.json({
        ...body,
        redacted: ['manifest.functions.f.input_parameters.api_token'],
      })
    }
    const result = await run(cli({ file, configurationToken, fetch: redacted }), [
      'app',
      'update',
      '--json',
    ])
    expect(result.json()).toMatchObject({ code: 'MANIFEST_HAS_SECRETS' })
    expect(slack.calls.map((call) => call.method)).toEqual(['apps.manifest.export'])
  })

  test('without a stored app id it names what to pass, before reading a token', async () => {
    const shared = credentialsFile(
      rotatingStore({ T1: { accessToken, clientId: SLACK_OAUTH_CLIENT_ID } }),
    )
    const unrecorded = credentialsFile(
      rotatingStore({ T1: { accessToken, clientId: '1111111111.2222222222' } }),
    )
    const onShared = await run(cli({ file: shared, fetch: noCallWithoutAppId }), [
      'app',
      'update',
      '--json',
    ])
    expect(onShared.json()).toMatchObject({ code: 'NOT_OWN_APP' })
    const onOwn = await run(cli({ file: unrecorded, fetch: noCallWithoutAppId }), [
      'app',
      'update',
      '--json',
    ])
    expect(onOwn.json()).toMatchObject({
      code: 'APP_ID_REQUIRED',
      message: expect.stringContaining('pass --app') as unknown,
    })
  })

  test('signing in through another app forgets the stored app id', async () => {
    const file = credentialsFile(rotatingStore({ T1: ownApp }))
    const oauth = consentHost(async () => 'auth-code-not-a-secret')
    await run(cli({ file, fetch: issueToken, oauth }), ['login', '--json'])
    expect(readCredentials(file).teams['T1']).toMatchObject({ appId: 'A0OWNAPP' })
    await run(cli({ file, fetch: issueToken, oauth }), ['login', '--client-id', 'shared', '--json'])
    expect(readCredentials(file).teams['T1']?.appId).toBeUndefined()
  })
})
