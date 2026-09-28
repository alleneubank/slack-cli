import { randomBytes } from 'node:crypto'
import { createWriteStream, openAsBlob } from 'node:fs'
import { link as hardLink, open, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { z, type Cli } from '@alleneubank/incur'

import { commandError, type Outcome } from './errors.js'
import { MESSAGE_LINK_SHAPE, parseMessageLink, type MessageLink } from './message-links.js'
import { callSlackMethod, failure, isRecord, type SlackBody, type WebApiDeps } from './web-api.js'

/** Slack's upload limit; a larger download or upload is refused rather than streamed. */
export const FILE_BYTES_MAX: number = 1024 ** 3
/** One file transfer, headers through last byte. */
export const FILE_TRANSFER_TIMEOUT_MS: number = 10 * 60_000
/** Files one upload shares, and files one download saves; Slack attaches at most 10 per message. */
const FILES_PER_COMMAND_MAX = 10
const REDIRECTS_MAX = 5

/** Slack file ids; ids from Slack are checked against it too, since they can name saved files. */
const fileId = /^F[A-Za-z0-9]+$/
const workspaceGlobals = z.object({ workspace: z.string().optional() })
const slackResponseSchema = z.object({ ok: z.boolean() }).passthrough()

/** What a download needs from a Slack file object. */
type SlackFile = { id: string; name: string; mimetype: string; size: number; url: string }

type SavedFile = Omit<SlackFile, 'url'> & { path: string }

/** Adds `slack files download` and `slack files upload`, which move bytes the Web API methods cannot. */
export function fileCommands(deps: WebApiDeps): (cli: Cli.Cli) => void {
  return (cli) => {
    cli.command('download', {
      description: 'Download a file, or every file on a message, with the stored login',
      hint: 'User token scopes: files:read, plus the history scope of the conversation for a message link.\nThe token goes only to https://*.slack.com.',
      args: z.object({
        target: z.string().describe(`File id (F…), or a message link: ${MESSAGE_LINK_SHAPE}`),
      }),
      options: z.object({
        file: z.string().optional().describe('With a message link, download only this file id'),
        out: z
          .string()
          .optional()
          .describe(
            'Directory to save into, or a file path for a single file. Default: the current directory, under each file name',
          ),
        force: z
          .boolean()
          .default(false)
          .describe('Replace a file that already exists at the path'),
      }),
      output: z.object({
        ok: z.literal(true),
        files: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            mimetype: z.string(),
            size: z.number(),
            path: z.string().describe('Absolute path of the saved file'),
          }),
        ),
      }),
      async run(context) {
        const { workspace } = workspaceGlobals.parse(context.globals)
        const outcome = await download(context.args.target, context.options, workspace, deps)
        return outcome.ok
          ? { ok: true as const, files: outcome.value }
          : context.error(commandError(outcome.error))
      },
    })
    cli.command('upload', {
      description: 'Upload files and share them in a conversation or thread',
      hint: 'User token scopes: files:write (slack login --write).\nRuns files.getUploadURLExternal, an HTTP POST of the bytes, then files.completeUploadExternal, whose response it prints. Without --channel the files stay private to you.',
      args: z.object({
        paths: z
          .array(z.string())
          .min(1)
          .max(FILES_PER_COMMAND_MAX)
          .describe(`Local files, at most ${FILES_PER_COMMAND_MAX}`),
      }),
      options: z.object({
        channel: z
          .string()
          .optional()
          .describe(
            `Channel id to share into, or a message link: ${MESSAGE_LINK_SHAPE}, which shares into that message's thread`,
          ),
        thread_ts: z.string().optional().describe('Thread parent ts to share into'),
        title: z.string().optional().describe('Title for a single file. Default: its file name'),
        initial_comment: z
          .string()
          .meta({ allowControlChars: true })
          .optional()
          .describe('Message text posted with the files'),
      }),
      output: slackResponseSchema,
      mutates: true,
      async run(context) {
        const { workspace } = workspaceGlobals.parse(context.globals)
        const outcome = await upload(context.args.paths, context.options, workspace, deps)
        return outcome.ok ? outcome.value : context.error(commandError(outcome.error))
      },
    })
  }
}

type DownloadOptions = { file?: string | undefined; out?: string | undefined; force: boolean }

async function download(
  target: string,
  options: DownloadOptions,
  workspace: string | undefined,
  deps: WebApiDeps,
): Promise<Outcome<SavedFile[]>> {
  const files = await filesToDownload(target, options.file, workspace, deps)
  if (!files.ok) return files
  const paths = await destinations(files.value, options.out)
  if (!paths.ok) return paths
  const saved: SavedFile[] = []
  for (const [index, file] of files.value.entries()) {
    const destination = paths.value[index]!
    // Resolved per file: a rotating token is refreshed when it nears expiry during a long download.
    const credential = await deps.credential(workspace)
    if (!credential.ok) return credential
    const written = await save(file, destination, options.force, credential.value.token, deps)
    if (!written.ok) return written
    const { url: _url, ...facts } = file
    saved.push({ ...facts, path: destination })
  }
  return { ok: true, value: saved }
}

async function filesToDownload(
  target: string,
  only: string | undefined,
  workspace: string | undefined,
  deps: WebApiDeps,
): Promise<Outcome<SlackFile[]>> {
  if (fileId.test(target)) {
    if (only !== undefined) return invalid('--file applies only to a message link')
    const file = await fileFacts({ id: target }, workspace, deps)
    return file.ok ? { ok: true, value: [file.value] } : file
  }
  const link = parseMessageLink(target)
  if (link === undefined)
    return invalid(
      `Expected a file id (F…) or a message link like ${MESSAGE_LINK_SHAPE}; got ${JSON.stringify(target)}`,
    )
  if (!link.ok) return link
  const message = await readMessage(link.value, workspace, deps)
  if (!message.ok) return message
  const attached = Array.isArray(message.value['files'])
    ? message.value['files'].filter(isRecord)
    : []
  if (attached.length === 0) return failure('NO_FILES', 'The linked message has no files')
  const chosen = only === undefined ? attached : attached.filter((entry) => entry['id'] === only)
  if (chosen.length === 0)
    return invalid(
      `The linked message has no file ${only}; its files: ${attached.map((entry) => String(entry['id'])).join(', ')}`,
    )
  if (chosen.length > FILES_PER_COMMAND_MAX)
    return invalid(
      `The linked message has ${chosen.length} files, more than ${FILES_PER_COMMAND_MAX}; pick one with --file <id>`,
    )
  const files: SlackFile[] = []
  for (const entry of chosen) {
    const file = await fileFacts(entry, workspace, deps)
    if (!file.ok) return file
    files.push(file.value)
  }
  return { ok: true, value: files }
}

/** Reads the one message a link names; a reply is read through its thread. */
async function readMessage(
  link: MessageLink,
  workspace: string | undefined,
  deps: WebApiDeps,
): Promise<Outcome<Record<string, unknown>>> {
  const window = { oldest: link.ts, latest: link.ts, inclusive: 'true', limit: '1' }
  const thread = link.threadTs === link.ts ? undefined : link.threadTs
  const read =
    thread !== undefined
      ? await callSlackMethod(
          'conversations.replies',
          { channel: link.channel, ts: thread, ...window },
          workspace,
          deps,
        )
      : await callSlackMethod(
          'conversations.history',
          { channel: link.channel, ...window },
          workspace,
          deps,
        )
  if (!read.ok) return read
  const messages = Array.isArray(read.value['messages']) ? read.value['messages'] : []
  const message = messages.filter(isRecord).find((candidate) => candidate['ts'] === link.ts)
  if (message !== undefined) return { ok: true, value: message }
  return failure(
    'MESSAGE_NOT_FOUND',
    thread !== undefined
      ? `No message ${link.ts} in thread ${thread} of ${link.channel}`
      : `No message ${link.ts} in ${link.channel}; for a thread reply, use the link Slack copies from the reply, which carries thread_ts`,
  )
}

/**
 * A file object from a message is complete for a download unless Slack left a
 * stub (Slack Connect files carry `file_access: "check_file_info"`); then
 * files.info supplies the rest.
 */
async function fileFacts(
  entry: Record<string, unknown>,
  workspace: string | undefined,
  deps: WebApiDeps,
): Promise<Outcome<SlackFile>> {
  const complete = entry['file_access'] === 'check_file_info' ? undefined : downloadable(entry)
  if (complete !== undefined) return { ok: true, value: complete }
  const id = String(entry['id'])
  const info = await callSlackMethod('files.info', { file: id }, workspace, deps)
  if (!info.ok) return info
  const file = isRecord(info.value['file']) ? downloadable(info.value['file']) : undefined
  if (file === undefined)
    return failure('FILE_UNAVAILABLE', `Slack returned no download URL for file ${id}`)
  return { ok: true, value: file }
}

function downloadable(file: Record<string, unknown>): SlackFile | undefined {
  const { id, name, title, mimetype, size } = file
  const url = file['url_private_download'] ?? file['url_private']
  if (typeof id !== 'string' || !fileId.test(id)) return undefined
  if (typeof url !== 'string' || typeof size !== 'number') return undefined
  const label = typeof name === 'string' && name.length > 0 ? name : title
  return {
    id,
    name: typeof label === 'string' ? label : id,
    mimetype: typeof mimetype === 'string' ? mimetype : 'application/octet-stream',
    size,
    url,
  }
}

/**
 * Where each file is saved: under its own name in `out` (default: the current
 * directory) when `out` is a directory, else at `out` itself for a single file.
 * Names come from other people, so only their last path segment is used.
 */
async function destinations(
  files: SlackFile[],
  out: string | undefined,
): Promise<Outcome<string[]>> {
  const target = path.resolve(out ?? '.')
  const isDirectory =
    out === undefined || (await stat(target).catch(() => undefined))?.isDirectory()
  if (!isDirectory) {
    if (files.length === 1) return { ok: true, value: [target] }
    return invalid(
      `The message has ${files.length} files; pass --file <id>, or a directory for --out`,
    )
  }
  const names = files.map((file) => localName(file))
  const repeated = new Set(names.filter((name, index) => names.indexOf(name) !== index))
  const paths = files.map((file, index) => {
    const name = names[index]!
    return path.join(target, repeated.has(name) ? `${file.id}-${name}` : name)
  })
  for (const saved of paths)
    if (path.dirname(saved) !== target) throw new Error(`${saved} is outside ${target}`)
  return { ok: true, value: paths }
}

function localName(file: SlackFile): string {
  const name = path.basename(file.name)
  return name === '' || name === '.' || name === '..' ? file.id : name
}

/**
 * Streams a file into a temporary sibling, then moves it into place, so a
 * failed download never leaves a partial file at the destination. Without
 * `force` the move is a hard link, which fails rather than replace a file
 * created at the destination during the download.
 */
async function save(
  file: SlackFile,
  destination: string,
  force: boolean,
  token: string,
  deps: WebApiDeps,
): Promise<Outcome<void>> {
  // Checked first as well, so an existing file fails before the download.
  if (!force && (await stat(destination).catch(() => undefined)) !== undefined)
    return fileExists(destination)
  if (file.size > FILE_BYTES_MAX) return tooLarge(file.id)
  const response = await fetchSlackFile(file, token, deps)
  if (!response.ok) return response
  const body = response.value.body
  if (body === null) return failure('BAD_RESPONSE', `Slack sent no body for file ${file.id}`)
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomBytes(6).toString('hex')}.part`,
  )
  try {
    await pipeline(
      Readable.fromWeb(body),
      boundedBytes(FILE_BYTES_MAX),
      createWriteStream(temporary, { flags: 'wx' }),
    )
    if (force) await rename(temporary, destination)
    else await hardLink(temporary, destination)
    return { ok: true, value: undefined }
  } catch (error) {
    if (isRecord(error) && error['code'] === 'EEXIST') return fileExists(destination)
    return transferFailure(error, file.id)
  } finally {
    await rm(temporary, { force: true })
  }
}

function fileExists(destination: string): Outcome<never> {
  return failure('FILE_EXISTS', `${destination} exists; pass --force to replace it`)
}

class TooLargeError extends Error {}

function boundedBytes(bytesMax: number): Transform {
  let bytes = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength
      if (bytes > bytesMax) callback(new TooLargeError())
      else callback(null, chunk)
    },
  })
}

function transferFailure(error: unknown, id: string): Outcome<never> {
  if (error instanceof TooLargeError) return tooLarge(id)
  if (error instanceof Error && error.name === 'TimeoutError')
    return failure(
      'TIMEOUT',
      `Downloading file ${id} timed out after ${FILE_TRANSFER_TIMEOUT_MS}ms`,
      true,
    )
  // Filesystem errors name the path they failed on; their message carries no secret.
  if (isRecord(error) && typeof error['path'] === 'string')
    return failure('WRITE_FAILED', `Saving file ${id} failed: ${String(error['message'])}`)
  // A transport error's message is not printed: a fetch wrapper may include the request's headers.
  return failure('NETWORK', `Downloading file ${id} failed (${errorKind(error)})`, true)
}

/** The error's class and code, e.g. `TypeError ECONNRESET`, without its message. */
function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const cause = isRecord(error.cause) ? error.cause : undefined
  const code = cause !== undefined && typeof cause['code'] === 'string' ? ` ${cause['code']}` : ''
  return `${error.name}${code}`
}

function tooLarge(id: string): Outcome<never> {
  return failure('FILE_TOO_LARGE', `File ${id} is larger than ${FILE_BYTES_MAX} bytes`)
}

/**
 * Fetches a file's private URL with the token. Redirects are followed by hand
 * so the token is sent only to https://*.slack.com, never to another host.
 */
async function fetchSlackFile(
  file: SlackFile,
  token: string,
  deps: WebApiDeps,
): Promise<Outcome<Response>> {
  const signal = AbortSignal.timeout(FILE_TRANSFER_TIMEOUT_MS)
  let url = URL.parse(file.url)
  for (let redirects = 0; redirects <= REDIRECTS_MAX; redirects += 1) {
    if (url === null || !isSlackHost(url))
      return failure(
        'UNTRUSTED_URL',
        `File ${file.id} is served from ${url?.origin ?? JSON.stringify(file.url)}; the Slack token is sent only to https://*.slack.com`,
      )
    let response: Response
    try {
      response = await deps.fetch(
        new Request(url, {
          headers: { authorization: `Bearer ${token}` },
          redirect: 'manual',
          signal,
        }),
      )
    } catch (error) {
      return transferFailure(error, file.id)
    }
    const location = response.headers.get('location')
    if (response.status < 300 || response.status > 399 || location === null)
      return checkedFile(response, file)
    await response.body?.cancel()
    url = URL.parse(location, url.href)
  }
  return failure('HTTP_ERROR', `File ${file.id} redirected more than ${REDIRECTS_MAX} times`)
}

async function checkedFile(response: Response, file: SlackFile): Promise<Outcome<Response>> {
  const html = response.headers.get('content-type')?.startsWith('text/html') === true
  if (response.ok && !(html && file.mimetype !== 'text/html')) return { ok: true, value: response }
  await response.body?.cancel()
  if (response.ok)
    // Slack answers a token it will not serve the file to with its sign-in page, not a 403.
    return failure(
      'FILE_ACCESS_DENIED',
      `Slack returned its sign-in page instead of file ${file.id}: the token cannot read it (files:read is required)`,
    )
  if (response.status === 429)
    return failure('RATE_LIMITED', `Slack rate limited the download of file ${file.id}`, true)
  const message = `Slack's file host returned HTTP ${response.status} for file ${file.id}`
  return failure('HTTP_ERROR', message, response.status >= 500)
}

/** The only origins the token is sent to: https://slack.com and its subdomains, on the default port. */
function isSlackHost(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))
  )
}

type UploadOptions = {
  channel?: string | undefined
  thread_ts?: string | undefined
  title?: string | undefined
  initial_comment?: string | undefined
}

/**
 * A local file checked before anything is sent to Slack. The blob is pinned to
 * the file as checked: reading it fails if the file changes afterwards.
 */
type LocalFile = { name: string; blob: Blob }

async function upload(
  paths: string[],
  options: UploadOptions,
  workspace: string | undefined,
  deps: WebApiDeps,
): Promise<Outcome<SlackBody>> {
  if (options.title !== undefined && paths.length > 1)
    return invalid('--title applies to a single file; Slack titles each file by its name otherwise')
  const share = shareTarget(options)
  if (!share.ok) return share
  const local: LocalFile[] = []
  for (const filePath of paths) {
    const checked = await localFile(filePath)
    if (!checked.ok) return checked
    local.push(checked.value)
  }
  const uploaded: { id: string; title?: string }[] = []
  for (const file of local) {
    const id = await uploadBytes(file, workspace, deps)
    if (!id.ok) return id
    uploaded.push({
      id: id.value,
      ...(options.title === undefined ? undefined : { title: options.title }),
    })
  }
  return callSlackMethod(
    'files.completeUploadExternal',
    { files: JSON.stringify(uploaded), ...share.value },
    workspace,
    deps,
  )
}

/** Slack arguments naming where the files are shared; a message link shares into its thread. */
function shareTarget(options: UploadOptions): Outcome<Record<string, string>> {
  const comment =
    options.initial_comment === undefined ? {} : { initial_comment: options.initial_comment }
  if (options.channel === undefined) {
    if (options.thread_ts !== undefined) return invalid('--thread_ts needs --channel')
    return { ok: true, value: comment }
  }
  const link = parseMessageLink(options.channel)
  if (link === undefined) {
    const thread = options.thread_ts === undefined ? {} : { thread_ts: options.thread_ts }
    return { ok: true, value: { channel_id: options.channel, ...thread, ...comment } }
  }
  if (!link.ok) return link
  if (options.thread_ts !== undefined)
    return invalid('A message link already names the thread; pass the link alone')
  const thread_ts = link.value.threadTs ?? link.value.ts
  return { ok: true, value: { channel_id: link.value.channel, thread_ts, ...comment } }
}

async function localFile(filePath: string): Promise<Outcome<LocalFile>> {
  const resolved = path.resolve(filePath)
  let isFile: boolean
  let blob: Blob
  try {
    // Opening proves the file is readable; openAsBlob alone defers that to the upload.
    const handle = await open(resolved, 'r')
    try {
      isFile = (await handle.stat()).isFile()
    } finally {
      await handle.close()
    }
    blob = await openAsBlob(resolved)
  } catch (error) {
    return invalid(
      `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isFile) return invalid(`${filePath} is not a file`)
  if (blob.size === 0) return invalid(`${filePath} is empty; Slack does not accept empty files`)
  if (blob.size > FILE_BYTES_MAX)
    return failure('FILE_TOO_LARGE', `${filePath} is larger than ${FILE_BYTES_MAX} bytes`)
  return { ok: true, value: { name: path.basename(resolved), blob } }
}

/** Reserves an upload with Slack and sends the bytes; the file is shared only by completeUploadExternal. */
async function uploadBytes(
  file: LocalFile,
  workspace: string | undefined,
  deps: WebApiDeps,
): Promise<Outcome<string>> {
  const reserved = await callSlackMethod(
    'files.getUploadURLExternal',
    { filename: file.name, length: String(file.blob.size) },
    workspace,
    deps,
  )
  if (!reserved.ok) return reserved
  const { upload_url: uploadUrl, file_id: id } = reserved.value
  if (typeof uploadUrl !== 'string' || typeof id !== 'string')
    return failure('BAD_RESPONSE', 'files.getUploadURLExternal returned no upload_url or file_id')
  const url = URL.parse(uploadUrl)
  if (url === null || !isSlackHost(url))
    return failure('UNTRUSTED_URL', `Slack returned an upload URL outside https://*.slack.com`)
  let response: Response
  try {
    response = await deps.fetch(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file.blob,
        redirect: 'error',
        signal: AbortSignal.timeout(FILE_TRANSFER_TIMEOUT_MS),
      }),
    )
  } catch (error) {
    if (
      error instanceof Error &&
      isRecord(error.cause) &&
      error.cause['name'] === 'NotReadableError'
    )
      return failure(
        'FILE_CHANGED',
        `${file.name} changed or became unreadable after it was checked`,
      )
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    // Nothing is shared until completeUploadExternal, so a failed transfer is safe to retry.
    return failure(
      timedOut ? 'TIMEOUT' : 'NETWORK',
      `Uploading ${file.name} failed (${errorKind(error)})`,
      true,
    )
  }
  await response.body?.cancel()
  if (!response.ok)
    return failure(
      'HTTP_ERROR',
      `Slack's upload host returned HTTP ${response.status} for ${file.name}`,
      response.status === 429 || response.status >= 500,
    )
  return { ok: true, value: id }
}

function invalid(message: string): Outcome<never> {
  return failure('INVALID_ARGUMENT', message)
}
