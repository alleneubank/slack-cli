/** What a credential in a Slack response is printed as. */
export const REDACTED = '[redacted]'

/** Keys whose string values are credentials: `token`, and any `*_token` or `*_secret`. */
const secretKey = /(?:^|_)(?:token|secret)$/

/** Deeper than any Slack response; a body nested past it is refused rather than walked. */
const depthMax = 64

export type Redacted = {
  value: Record<string, unknown>
  /** Where credentials were replaced, as paths like `credentials.client_secret`. */
  paths: string[]
}

/**
 * Copies a parsed Slack response with every credential value replaced by
 * `REDACTED`. Returns undefined when the body nests deeper than `depthMax`.
 */
export function redactSecrets(body: Record<string, unknown>): Redacted | undefined {
  const paths: string[] = []
  try {
    return { value: copyObject(body, '', 0, paths), paths }
  } catch (error) {
    if (error instanceof TooDeepError) return undefined
    throw error
  }
}

class TooDeepError extends Error {}

function copyObject(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  paths: string[],
): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) {
    const fieldPath = path === '' ? key : `${path}.${key}`
    if (secretKey.test(key) && typeof field === 'string' && field !== '') {
      copy[key] = REDACTED
      paths.push(fieldPath)
    } else copy[key] = copyValue(field, fieldPath, depth + 1, paths)
  }
  return copy
}

function copyValue(value: unknown, path: string, depth: number, paths: string[]): unknown {
  if (typeof value !== 'object' || value === null) return value
  if (depth > depthMax) throw new TooDeepError()
  if (Array.isArray(value))
    return value.map((item, index) => copyValue(item, `${path}[${index}]`, depth + 1, paths))
  return copyObject(value as Record<string, unknown>, path, depth, paths)
}
