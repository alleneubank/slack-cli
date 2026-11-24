import packageManifest from '../package.json' with { type: 'json' }

/** The package version, built in so it needs no file at run time. */
export const VERSION: string = packageManifest.version

/** Public source repository, linked from help and the OAuth callback page. */
export const SOURCE_URL: string = 'https://github.com/alleneubank/slack-cli'
