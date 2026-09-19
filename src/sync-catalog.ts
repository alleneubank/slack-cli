/**
 * Regenerates `src/catalog.json` from Slack's method reference. Run with
 * `nub run sync-catalog`; review the diff before committing. The CLI never
 * fetches the reference at runtime.
 */
import { writeFile } from 'node:fs/promises'

import {
  acceptsUserToken,
  parseIndex,
  parseMethodPage,
  REFERENCE_INDEX_URL,
  type Catalog,
  type CatalogMethod,
  type IndexEntry,
} from './reference.js'

const catalogUrl = new URL('./catalog.json', import.meta.url)
const fetchConcurrency = 8
const fetchAttemptsMax = 3
const fetchTimeoutMs = 30_000
const pageLengthMax = 2_000_000

const index = parseIndex(await fetchText(REFERENCE_INDEX_URL))
const pages = await mapBounded(index, fetchConcurrency, readMethod)
const methods = pages.filter(acceptsUserToken).toSorted((a, b) => (a.name < b.name ? -1 : 1))
const catalog: Catalog = { source: 'https://docs.slack.dev/reference/methods', methods }
await writeFile(catalogUrl, `${JSON.stringify(catalog, null, 2)}\n`)
process.stderr.write(
  `catalog: ${methods.length} methods (${pages.length - methods.length} bot-only skipped)\n`,
)

async function readMethod(entry: IndexEntry): Promise<CatalogMethod> {
  const method = parseMethodPage(await fetchText(entry.url))
  if (method.name !== entry.name)
    throw new Error(`${entry.url} documents ${method.name}, index says ${entry.name}`)
  return method
}

async function fetchText(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(fetchTimeoutMs) })
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
      const text = await response.text()
      if (text.length > pageLengthMax)
        throw new Error(`${url}: page exceeds ${pageLengthMax} characters`)
      return text
    } catch (error) {
      if (attempt >= fetchAttemptsMax) throw error
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
    }
  }
}

async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const position = next++
      results[position] = await map(items[position]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}
