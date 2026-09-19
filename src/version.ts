import { readFileSync } from 'node:fs'

type PackageManifest = { version: string }

/** The package version, read from `package.json` beside `src/` in development and `dist/` when installed. */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest
).version

/** Public source repository, linked from help and the OAuth callback page. */
export const SOURCE_URL: string = 'https://github.com/alleneubank/slack-cli'
