import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Bun places a compiled executable's own modules under this virtual root;
 * nothing beside them is on disk.
 */
const compiledModuleRoot = 'file:///$bunfs/'

/**
 * Where the package's files (`slack-app-manifest.json`, `skills/`) live: the
 * directory above `dist/` in the npm package, or above `bin/` in a compiled
 * release archive.
 */
export const PACKAGE_ROOT: string = import.meta.url.startsWith(compiledModuleRoot)
  ? path.resolve(path.dirname(process.execPath), '..')
  : fileURLToPath(new URL('..', import.meta.url))
