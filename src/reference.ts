/**
 * Parser for Slack's Web API method reference on docs.slack.dev. Every method
 * page has a Markdown twin with YAML frontmatter and an `## Arguments` section;
 * this module turns those pages into catalog entries and fails on anything it
 * does not recognize, so a docs format change surfaces as a sync error.
 */

export const REFERENCE_INDEX_URL: string = 'https://docs.slack.dev/reference/methods.md'

const argumentTypes = ['string', 'boolean', 'integer', 'number', 'array', 'object'] as const

export type ArgumentType = (typeof argumentTypes)[number]

export type CatalogArgument = {
  name: string
  /** Absent when the reference states no type. */
  type?: ArgumentType
  required: boolean
  description: string
  default?: string
  example?: string
}

export type CatalogMethod = {
  name: string
  summary: string
  httpMethod: 'GET' | 'POST'
  /** Rate limit tier (`t1`–`t4`), `t5` for special limits, or Slack's free text. */
  rateLimit?: string
  scopes: { bot: string[]; user: string[] }
  /** Top-level fields of the page's successful example responses; absent when none parses. */
  responseFields?: string[]
  args: CatalogArgument[]
}

export type Catalog = {
  source: string
  methods: CatalogMethod[]
}

export type IndexEntry = { name: string; url: string }

export class ReferenceParseError extends Error {
  override name = 'ReferenceParseError'
}

/** Lists the method pages linked from the reference index. */
export function parseIndex(markdown: string): IndexEntry[] {
  const entries: IndexEntry[] = []
  const seen = new Set<string>()
  const link =
    /\| \[([A-Za-z0-9_.]+)\]\((https:\/\/docs\.slack\.dev\/reference\/methods\/[^)\s]+\.md)\) \|/g
  for (const match of markdown.matchAll(link)) {
    const [, name, url] = match as unknown as [string, string, string]
    if (seen.has(name)) throw new ReferenceParseError(`Duplicate index entry: ${name}`)
    seen.add(name)
    entries.push({ name, url })
  }
  if (entries.length === 0) throw new ReferenceParseError('Reference index lists no methods')
  return entries
}

/** Parses one method page. */
export function parseMethodPage(markdown: string): CatalogMethod {
  const frontmatter = parseFrontmatter(markdown)
  const name = requiredString(frontmatter.fields, 'method_name', '(unknown method)')
  const httpMethod = requiredString(frontmatter.fields, 'http_method', name)
  if (httpMethod !== 'GET' && httpMethod !== 'POST')
    throw new ReferenceParseError(`${name}: unsupported http_method ${httpMethod}`)
  const responseFields = parseResponseFields(markdown.slice(frontmatter.end))
  const rateLimit = frontmatter.fields.get('rate_limit')
  if (rateLimit !== undefined && typeof rateLimit !== 'string')
    throw new ReferenceParseError(`${name}: rate_limit is not a string`)
  return {
    name,
    summary: requiredString(frontmatter.fields, 'summary', name),
    httpMethod,
    ...(rateLimit === undefined ? undefined : { rateLimit }),
    scopes: {
      bot: frontmatter.scopes.get('bot') ?? [],
      user: frontmatter.scopes.get('user') ?? [],
    },
    args: parseArguments(markdown.slice(frontmatter.end), name),
    ...(responseFields === undefined ? undefined : { responseFields }),
  }
}

/**
 * Example responses are illustrations, not a schema: some are not valid JSON,
 * so fields come from whichever successful examples parse.
 */
function parseResponseFields(body: string): string[] | undefined {
  const section = /\n## Response[^\n]*\n([\s\S]*?)(?=\n## |$)/.exec(body)
  if (!section) return undefined
  const fields = new Set<string>()
  for (const block of section[1]!.matchAll(/```[a-z]*\n([\s\S]*?)\n```/g)) {
    let example: unknown
    try {
      example = JSON.parse(block[1]!)
    } catch {
      continue
    }
    if (typeof example === 'object' && example !== null && 'ok' in example && example.ok === true)
      for (const field of Object.keys(example)) fields.add(field)
  }
  return fields.size > 0 ? [...fields] : undefined
}

/** A method a user token can call: its page lists user scopes, or no scopes at all. */
export function acceptsUserToken(method: CatalogMethod): boolean {
  return method.scopes.user.length > 0 || method.scopes.bot.length === 0
}

type Frontmatter = {
  fields: Map<string, unknown>
  scopes: Map<string, string[]>
  end: number
}

function parseFrontmatter(markdown: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown)
  if (!match) throw new ReferenceParseError('Page has no frontmatter')
  const fields = new Map<string, unknown>()
  const scopes = new Map<string, string[]>()
  let inScopes = false
  for (const line of match[1]!.split('\n')) {
    const scope = /^ {2}(bot|user): (\[.*\])$/.exec(line)
    if (scope && inScopes) {
      scopes.set(scope[1]!, stringArray(JSON.parse(scope[2]!), line))
      continue
    }
    const field = /^([a-z_]+):(?: (".*"))?$/.exec(line)
    if (!field) throw new ReferenceParseError(`Unrecognized frontmatter line: ${line}`)
    inScopes = field[1] === 'scopes' && field[2] === undefined
    if (field[2] !== undefined) fields.set(field[1]!, JSON.parse(field[2]) as unknown)
  }
  return { fields, scopes, end: match[0].length }
}

const argumentHeader = /^\*\*`([^`]+)`\*\*(?:`([^`]+)`)?(Required|Optional)$/
const valueLine = /^_(Example|Default|Acceptable values):_ (.*)$/
/** Lines the docs renderer leaves inside argument blocks that carry no content. */
const renderingArtifacts = new Set(['0', '* * *'])

function parseArguments(body: string, method: string): CatalogArgument[] {
  const section = /\n## Arguments[^\n]*\n([\s\S]*?)(?=\n## )/.exec(body)
  if (!section) throw new ReferenceParseError(`${method}: no Arguments section`)
  const args: CatalogArgument[] = []
  let current: { argument: CatalogArgument; description: string[] } | undefined
  const finish = () => {
    if (current === undefined) return
    current.argument.description = current.description.join(' ')
    if (current.argument.name !== 'token') args.push(current.argument)
    current = undefined
  }

  for (const raw of section[1]!.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || renderingArtifacts.has(line)) continue
    if (/^### (Required|Optional) arguments$/.test(line)) {
      finish()
      continue
    }
    const header = argumentHeader.exec(line)
    if (header) {
      finish()
      current = { argument: newArgument(header, method), description: [] }
      continue
    }
    if (line.startsWith('**') || line.startsWith('#'))
      throw new ReferenceParseError(`${method}: unrecognized argument line: ${line}`)
    if (current === undefined)
      throw new ReferenceParseError(`${method}: text outside an argument: ${line}`)
    const value = valueLine.exec(line)
    if (value?.[1] === 'Example') current.argument.example = unquote(value[2]!)
    else if (value?.[1] === 'Default') current.argument.default = unquote(value[2]!)
    else if (value?.[1] === 'Acceptable values')
      current.description.push(`Acceptable values: ${plainText(value[2]!)}`)
    else current.description.push(plainText(line))
  }
  finish()

  const names = new Set<string>()
  for (const argument of args) {
    if (names.has(argument.name))
      throw new ReferenceParseError(`${method}: duplicate argument ${argument.name}`)
    names.add(argument.name)
  }
  return args
}

function newArgument(header: RegExpExecArray, method: string): CatalogArgument {
  const name = header[1]!
  const type = header[2]
  const requirement = header[3]
  if (type !== undefined && !isArgumentType(type))
    throw new ReferenceParseError(`${method}: argument ${name} has unknown type ${type}`)
  return {
    name,
    ...(type === undefined ? undefined : { type }),
    required: requirement === 'Required',
    description: '',
  }
}

function isArgumentType(value: string): value is ArgumentType {
  return (argumentTypes as readonly string[]).includes(value)
}

/** Markdown links become their text; escaped underscores become underscores. */
function plainText(line: string): string {
  return line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\\_/g, '_')
}

function unquote(value: string): string {
  const code = /^`(.*)`$/.exec(value)
  return plainText(code ? code[1]! : value)
}

function requiredString(fields: Map<string, unknown>, key: string, method: string): string {
  const value = fields.get(key)
  if (typeof value !== 'string' || value.length === 0)
    throw new ReferenceParseError(`${method}: frontmatter ${key} is missing`)
  return value
}

function stringArray(value: unknown, line: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new ReferenceParseError(`Scopes are not a string list: ${line}`)
  return value
}
