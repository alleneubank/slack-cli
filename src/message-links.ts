import type { Outcome } from './errors.js'
import type { SlackMethod } from './methods.js'

/** A Slack message link, e.g. `https://acme.slack.com/archives/C0123456789/p1789757627925439`. */
type MessageLink = {
  channel: string
  ts: string
  /** The thread parent, from the link's `thread_ts` query parameter. */
  threadTs: string | undefined
}

export const MESSAGE_LINK_SHAPE: string =
  'https://<workspace>.slack.com/archives/<channel>/p<digits>, optionally with ?thread_ts=<ts>'

/** `conversations.history` options that bound the messages read; a link sets them to one message. */
export const HISTORY_WINDOW_OPTIONS: readonly string[] = ['oldest', 'latest', 'inclusive', 'limit']

const slackHost = /^(?:[a-z0-9-]+\.)+slack\.com$/
/** The `p` segment is the ts without its dot: ten digits of seconds, six of microseconds. */
const archivePath = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/
const slackTs = /^\d{10}\.\d{6}$/

/**
 * Reads a message link. Returns undefined for a value that is not link-shaped
 * (channel ids never contain `/`), and a failure for a link that does not parse.
 */
function parseMessageLink(value: string): Outcome<MessageLink> | undefined {
  if (!value.includes('/')) return undefined
  const url = URL.parse(value)
  const onSlack = url !== null && url.protocol === 'https:' && slackHost.test(url.hostname)
  const path = onSlack ? archivePath.exec(url.pathname) : null
  const threadTs = url?.searchParams.get('thread_ts') ?? undefined
  if (path === null || (threadTs !== undefined && !slackTs.test(threadTs)))
    return invalid(
      `Expected a message link like ${MESSAGE_LINK_SHAPE}; got ${JSON.stringify(value)}`,
    )
  const [, channel, seconds, microseconds] = path
  return { ok: true, value: { channel: channel!, ts: `${seconds}.${microseconds}`, threadTs } }
}

/**
 * Resolves a message link given for the `channel` positional into the Slack
 * arguments it names. Input without a link passes through, but a method with
 * a ts positional still needs that ts.
 */
export function withMessageLink(
  method: SlackMethod,
  input: Record<string, unknown>,
): Outcome<Record<string, unknown>> {
  const target = method.messageLink
  if (target === undefined) return { ok: true, value: input }
  const parsed = parseMessageLink(String(input['channel']))
  if (parsed !== undefined && !parsed.ok) return parsed
  const link = parsed?.value
  if (target.use === 'history') {
    if (link === undefined) return { ok: true, value: input }
    const windowGiven = HISTORY_WINDOW_OPTIONS.some((key) => input[key] !== undefined)
    const window = windowGiven
      ? {}
      : { oldest: link.ts, latest: link.ts, inclusive: true, limit: 1 }
    return { ok: true, value: { ...input, ...window, channel: link.channel } }
  }
  const tsGiven = input[target.ts] !== undefined
  if (link === undefined && !tsGiven)
    return invalid(`Pass <channel> <${target.ts}>, or a message link like ${MESSAGE_LINK_SHAPE}`)
  if (link === undefined) return { ok: true, value: input }
  if (tsGiven) return invalid(`A message link already names the ${target.ts}; pass the link alone`)
  const ts = target.use === 'thread' ? (link.threadTs ?? link.ts) : link.ts
  return { ok: true, value: { ...input, channel: link.channel, [target.ts]: ts } }
}

function invalid(message: string): Outcome<never> {
  return { ok: false, error: { code: 'INVALID_ARGUMENT', message } }
}
