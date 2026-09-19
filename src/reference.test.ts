import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import {
  acceptsUserToken,
  parseIndex,
  parseMethodPage,
  ReferenceParseError,
  type CatalogArgument,
} from './reference.js'

/** Real docs.slack.dev pages saved on 2026-09-18. */
function page(name: string): string {
  return readFileSync(new URL(`../fixtures/reference/${name}.md`, import.meta.url), 'utf8')
}

function argumentsByName(name: string): Record<string, CatalogArgument> {
  return Object.fromEntries(parseMethodPage(page(name)).args.map((arg) => [arg.name, arg]))
}

describe('Slack method reference parser', () => {
  test('index lists every documented method once', () => {
    const entries = parseIndex(page('methods'))
    expect(entries).toHaveLength(324)
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(324)
    expect(entries).toContainEqual({
      name: 'chat.postMessage',
      url: 'https://docs.slack.dev/reference/methods/chat.postmessage.md',
    })
  })

  test('reads chat.postMessage facts and arguments', () => {
    expect(parseMethodPage(page('chat.postmessage'))).toMatchObject({
      name: 'chat.postMessage',
      summary: 'Sends a message to a channel.',
      httpMethod: 'POST',
      rateLimit: 't5',
      scopes: { bot: ['chat:write'], user: ['chat:write'] },
    })
    const args = argumentsByName('chat.postmessage')
    expect(args['token']).toBeUndefined()
    expect(args['channel']).toMatchObject({ type: 'string', required: true })
    expect(args['text']).toMatchObject({ required: false, example: 'Hello world' })
    expect(args['text']).not.toHaveProperty('type')
    expect(args['mrkdwn']).toMatchObject({ type: 'boolean', default: 'true', example: 'false' })
    expect(args['blocks']?.description).toBe(
      'A JSON-based array of structured blocks, presented as a URL-encoded string.',
    )
  })

  test('reads a paginated read method', () => {
    expect(parseMethodPage(page('conversations.history'))).toMatchObject({
      httpMethod: 'GET',
      rateLimit: 't3',
      scopes: { user: ['groups:history', 'im:history', 'mpim:history', 'channels:history'] },
    })
    const args = argumentsByName('conversations.history')
    expect(args['channel']).toMatchObject({ required: true })
    expect(args['cursor']).toMatchObject({ type: 'string', required: false })
    expect(args['limit']).toMatchObject({ type: 'number', default: '100', example: '20' })
    expect(args['cursor']?.description).toContain('See pagination for more detail.')
  })

  test('lists the top-level fields of every successful example response', () => {
    expect(parseMethodPage(page('chat.postmessage')).responseFields).toEqual([
      'ok',
      'channel',
      'ts',
      'message',
    ])
    expect(parseMethodPage(page('conversations.history')).responseFields).toEqual([
      'ok',
      'messages',
      'has_more',
      'pin_count',
      'response_metadata',
      'latest',
    ])
  })

  test('keeps acceptable values in the description', () => {
    expect(argumentsByName('search.messages')['sort_dir']).toMatchObject({
      default: 'desc',
      description: expect.stringContaining('Acceptable values: `asc` `desc`') as unknown,
    })
  })

  test('a user token can call methods with user scopes or no scopes, not bot-only ones', () => {
    const authTest = parseMethodPage(page('auth.test'))
    expect(authTest.scopes).toEqual({ bot: [], user: [] })
    expect(authTest.args).toEqual([])
    expect(acceptsUserToken(authTest)).toBe(true)
    expect(acceptsUserToken(parseMethodPage(page('chat.postmessage')))).toBe(true)
    expect(acceptsUserToken(parseMethodPage(page('apps.datastore.get')))).toBe(false)
  })

  test('fails on an argument line it does not recognize', () => {
    const changed = page('chat.postmessage').replace(
      '**`channel`**`string`Required',
      '**`channel`** `string` (required)',
    )
    expect(() => parseMethodPage(changed)).toThrow(ReferenceParseError)
    expect(() => parseMethodPage(changed)).toThrow(/chat\.postMessage: unrecognized argument line/)
  })

  test('fails on an argument type it does not know', () => {
    const changed = page('chat.postmessage').replace(
      '**`channel`**`string`Required',
      '**`channel`**`enum`Required',
    )
    expect(() => parseMethodPage(changed)).toThrow(/argument channel has unknown type enum/)
  })

  test('fails on a page without frontmatter or arguments', () => {
    expect(() => parseMethodPage('# chat.postMessage\n')).toThrow(/no frontmatter/)
    const withoutArguments = page('auth.test').replace(/\n## Arguments[^\n]*\n/, '\n')
    expect(() => parseMethodPage(withoutArguments)).toThrow(/auth\.test: no Arguments section/)
  })
})
