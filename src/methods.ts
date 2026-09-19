import { z } from '@alleneubank/incur'

import catalogJson from './catalog.json' with { type: 'json' }
import { isDestructive, MUTATING_METHODS, POSITIONAL_ARGUMENTS } from './overlay.js'
import type { Catalog, CatalogArgument, CatalogMethod } from './reference.js'

const catalog = catalogJson as Catalog

/** Flags the CLI owns. A Slack argument with one of these names is exposed as `--slack_<name>`. */
const reservedFlags: ReadonlySet<string> = new Set([
  'config',
  'fields',
  'format',
  'help',
  'json',
  'llms',
  'mcp',
  'schema',
  'update',
  'version',
  'workspace',
])

type Shape = Record<string, z.ZodType>

/** A catalog method resolved into a command definition. */
export type SlackMethod = {
  /** Slack method name, e.g. `users.profile.get`. */
  name: string
  /** Command path below the family, e.g. `['profile', 'get']`. */
  path: string[]
  summary: string
  hint: string
  mutates: boolean
  /** Destroys data or access; agents confirm with the user first. */
  destructive: boolean
  args: z.ZodObject<Shape>
  options: z.ZodObject<Shape>
  /** Slack argument name for each positional and option key. */
  parameters: ReadonlyMap<string, string>
}

export const SLACK_METHOD_FAMILIES: string[] = [
  ...new Set(catalog.methods.map((method) => familyOf(method.name))),
]

const familySummaryLengthMax = 100

/** Root help line for a family, e.g. `Slack chat.* methods (14): appendStream, delete, …`. */
export function familySummary(family: string): string {
  const names = catalog.methods
    .filter((method) => familyOf(method.name) === family)
    .map((method) => method.name.slice(family.length + 1))
  const head = `Slack ${family}.* methods (${names.length}): `
  let listed = ''
  for (const name of names) {
    const next = listed === '' ? name : `${listed}, ${name}`
    if (head.length + next.length > familySummaryLengthMax) return `${head}${listed}, …`
    listed = next
  }
  return `${head}${listed}`
}

/** Methods of one top-level family, e.g. `conversations`. */
export function slackMethods(family: string): SlackMethod[] {
  return catalog.methods
    .filter((method) => familyOf(method.name) === family)
    .map((method) => resolveMethod(method))
}

function resolveMethod(method: CatalogMethod): SlackMethod {
  const positionals = POSITIONAL_ARGUMENTS[method.name] ?? []
  const args: Shape = {}
  const options: Shape = {}
  const parameters = new Map<string, string>()
  for (const name of positionals) {
    const argument = method.args.find((candidate) => candidate.name === name)
    if (argument === undefined || !argument.required)
      throw new Error(`Overlay positional ${method.name} ${name} is not a required argument`)
    args[name] = z.string().describe(describeArgument(argument))
    parameters.set(name, name)
  }
  for (const argument of method.args) {
    if (positionals.includes(argument.name)) continue
    const key = reservedFlags.has(argument.name) ? `slack_${argument.name}` : argument.name
    options[key] = optionSchema(argument)
    parameters.set(key, argument.name)
  }
  return {
    name: method.name,
    path: method.name.split('.').slice(1),
    summary: method.summary,
    hint: hint(method),
    mutates: MUTATING_METHODS.has(method.name) || hasWriteScope(method),
    destructive: isDestructive(method.name),
    args: z.object(args),
    options: z.object(options),
    parameters,
  }
}

function describeArgument(argument: CatalogArgument): string {
  const parts = [argument.description]
  if (argument.default !== undefined) parts.push(`Default: ${argument.default}.`)
  if (argument.example !== undefined) parts.push(`Example: ${argument.example}.`)
  return parts.join(' ')
}

function optionSchema(argument: CatalogArgument): z.ZodType {
  const description = describeArgument(argument)
  const base =
    argument.type === 'boolean'
      ? z.boolean()
      : argument.type === 'integer'
        ? z.number().int()
        : argument.type === 'number'
          ? z.number()
          : // Sent verbatim as a form field, where message text and JSON need newlines.
            // Positional ids keep incur's control-character check.
            z.string().meta({ allowControlChars: true })
  return (argument.required ? base : base.optional()).describe(description)
}

function hint(method: CatalogMethod): string {
  const lines: string[] = []
  if (method.scopes.user.length > 0)
    lines.push(`User token scopes: ${method.scopes.user.join(', ')}`)
  if (method.rateLimit !== undefined)
    lines.push(`Rate limit: ${rateTiers[method.rateLimit] ?? method.rateLimit}`)
  if (method.responseFields !== undefined)
    lines.push(`Response fields: ${method.responseFields.join(', ')}`)
  const names = new Set(method.args.map((argument) => argument.name))
  if (names.has('cursor')) lines.push('Next page: pass response_metadata.next_cursor as --cursor')
  if (names.has('page')) lines.push('Next page: pass the next page number as --page')
  lines.push(`Reference: ${catalog.source}/${method.name}`)
  return lines.join('\n')
}

/** Tiers from https://docs.slack.dev/apis/web-api/rate-limits; the reference writes the special tier as `t5`. */
const rateTiers: Readonly<Record<string, string>> = {
  t1: 'Tier 1 (1+ per minute)',
  t2: 'Tier 2 (20+ per minute)',
  t3: 'Tier 3 (50+ per minute)',
  t4: 'Tier 4 (100+ per minute)',
  t5: 'Special; see the reference',
}

function hasWriteScope(method: CatalogMethod): boolean {
  return [...method.scopes.user, ...method.scopes.bot].some((scope) => scope.includes(':write'))
}

function familyOf(name: string): string {
  return name.slice(0, name.indexOf('.'))
}
