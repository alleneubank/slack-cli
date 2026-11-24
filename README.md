# slack-cli

An unofficial command-line client for the
[Slack Web API](https://docs.slack.dev/reference/methods), for people and
coding agents. Every Web API method a user token can call is a typed command:
`conversations.history` is `slack conversations history`. `slack files download`
and `slack files upload` move file contents, which no Web API method does.

> **Not affiliated with Slack.** This project is not made, endorsed, or
> sponsored by Slack Technologies, LLC. "Slack" is a trademark of Slack
> Technologies, LLC. Slack's own [Slack CLI](https://docs.slack.dev/tools/slack-cli/),
> which builds Slack apps, also installs a `slack` binary; with both
> installed, whichever comes first on `PATH` runs.

Commands are generated from a catalog parsed out of Slack's public
[method reference](https://docs.slack.dev/reference/methods) and built on
[`@alleneubank/incur`](https://github.com/alleneubank/incur). Output is
Slack's own JSON. The CLI does not reimplement Slack method semantics, does
not mount Slack's hosted MCP, and is not an MCP server.

## Install

Requires Node.js 22 or later.

```sh
npm install --global @alleneubank/slack-cli
slack --help
```

Each [GitHub release](https://github.com/alleneubank/slack-cli/releases) also
carries standalone executables that need no Node.js, for macOS (arm64, x64)
and Linux (x64, arm64): `slack-<version>-<os>-<arch>.tar.gz`, with
`SHA256SUMS` and a build provenance attestation
(`gh attestation verify <archive> --repo alleneubank/slack-cli`). Unpack it
and put `bin/slack` on your `PATH`, keeping the archive's other files beside
`bin/`: `slack skills add` and `slack app create` read them. The executables
are built with Bun and are not notarized, so on macOS a copy downloaded
through a browser needs `xattr -d com.apple.quarantine bin/slack`.

## Sign in

```sh
slack login          # read scopes
slack login --write  # also write scopes: messages, channels, files, profile, and more
slack login --paste  # on a machine the browser cannot reach, such as over SSH
```

Login prints an authorize URL and opens your browser. It uses public OAuth
with PKCE against the project's Slack app, "CLI for Slack (unofficial)". There
is no client secret and no server. Slack requires an HTTPS redirect for
distributed apps, so it redirects to a static page,
<https://alleneubank.github.io/slack-cli/callback/> (source in
[`docs/callback/`](docs/callback/)), which hands the one-time code to the CLI's
listener on `http://127.0.0.1:8912/callback`. One login can wait there at a
time; a second fails with `LOGIN_IN_PROGRESS`. With `--paste`, the page shows
the code and the CLI reads it from the terminal instead. The code is useless
without the PKCE verifier, which never leaves your machine, and the token goes
from Slack straight to your machine; the app's developers never receive it.

Each login adds the authorized workspace to
`~/.config/slack-cli/credentials.json` (mode 0600) and makes it current.
`slack workspaces list` shows the stored workspaces, the current one, the
Slack app each signed in through, and token expiry, never the tokens;
`--scopes` adds the granted scopes. `slack workspaces use
T0123456789` changes the current workspace; `--workspace T0123456789` or
`SLACK_WORKSPACE` picks one for a single command. `slack logout` removes the
selected workspace; `slack logout --all` removes every one.

`SLACK_TOKEN` overrides every stored workspace when set and is never
refreshed. `slack --help` lists the environment variables and shows a set
`SLACK_TOKEN` only as `(set)`. There is no `--token` flag, so tokens never
land in shell history or process listings.

Login asks for every user scope a command needs that Slack lets the app
request. Plain `slack login` asks only for scopes no state-changing method
accepts; `--write` adds the rest. The `admin.*` scopes (Enterprise
organizations only), the legacy `admin` scope, `app_configurations:write`,
`hosting:read`, `identity:read`, `openid`, `client`, and `tokens.basic` are
left out, so the commands that need them fail with `missing_scope` unless
`SLACK_TOKEN` holds a token that has them.

Slack keeps the scopes a user granted this app at earlier logins: after one
`slack login --write`, a later plain `slack login` still returns a token with
write scopes. `slack workspaces list --scopes` shows what the token carries.

Tokens do not expire. Slack gives each user one token per app and workspace,
so every machine signed in as you shares it: `slack auth revoke` invalidates
it at Slack and signs all of them out, while `slack logout` only removes it
from this machine. A rotating token
stored by an earlier version (12-hour `xoxe.` tokens) is still refreshed
shortly before it expires, and once if Slack answers `token_expired`, and the
new pair is saved under a file lock.

### Using your own Slack app

A workspace can sign in to the project's app only while the app's public
distribution is enabled, and some workspaces restrict third-party apps. The
app is not listed in the Slack Marketplace, so Slack
[limits](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)
its new installs: `conversations history` and `conversations replies` return
at most 15 messages per call and allow 1 request per minute. An app created in
your own workspace keeps the normal limits.

`slack app create` makes that app and signs the workspace in through it.
First generate an app configuration token for the workspace at
[api.slack.com/apps](https://api.slack.com/apps) ("Your App Configuration
Tokens" → "Generate Token"), then run:

```sh
slack app create --write                                   # paste at the hidden prompt
op read 'op://Private/Slack config token/credential' | slack app create --write
```

The access token (`xoxe.xoxp-…`) goes in at the hidden prompt or on stdin,
never as an argument. The command creates an app that is not distributed from
the bundled [`slack-app-manifest.json`](slack-app-manifest.json) in the
workspace chosen when the token was generated, then runs `slack login` through
it. The configuration token
is used for that one call and is never stored or printed; Slack's client
secret and signing secret for the new app are discarded, since PKCE login
needs neither. If sign-in fails after the app exists, the error names the
`slack login --client-id` command that finishes it; running `slack app create`
again would create a second app. An earlier authorization of the project's
app in that workspace stays in place; remove it under Manage apps in Slack.

The workspace records the new app's id. When a later release requests scopes
the app lacks, Slack's consent page says "Invalid permissions requested";
add them with a new configuration token, then sign in again:

```sh
slack app update                 # paste at the hidden prompt, or pipe it on stdin
slack login --write
```

`slack app update` reads the app's manifest, adds the user scopes, redirect,
and PKCE setting that login needs, and keeps the app's name, icon, and other
scopes. Running it again changes nothing. For an app made by hand, pass its
App ID: `slack app update --app A0123456789`.

To create the app by hand instead, paste the manifest at
[api.slack.com/apps](https://api.slack.com/apps) ("Create New App" → "Paste a
manifest", choose the workspace, "Create and Install"), close the install page
Slack opens, copy the Client ID from the app's "Basic Information" page, and
sign in through it:

```sh
slack login --client-id 1234567890.1234567890 --write
```

The workspace keeps that app: `slack login`, with or without `--write`, signs
in through the client id stored for the workspace named by `--workspace` or
`SLACK_WORKSPACE`, else the current one, and `slack workspaces list` shows
`app: own` with the client id. Login prints the app it uses before the
authorize URL. `SLACK_CLIENT_ID` overrides the stored app for every login.

An app that is not distributed can sign in only the workspace that created it.
While such a workspace is current, add another workspace with
`slack login --client-id shared` (the project's app) or with that workspace's
own client id. Only the workspace that signs in is changed; the new one becomes
current, and `slack workspaces use` switches back.

The manifest registers the same HTTPS redirect page, which works for any
client id, and keeps token rotation off so tokens need no client secret to
refresh.

## Usage

```sh
slack --help
slack conversations --help
slack conversations list --types public_channel --limit 20
slack conversations history C0123456789 --limit 20 --json
slack conversations replies C0123456789 1726600000.000100
slack users info --user U0123456789
slack chat postMessage C0123456789 --text 'hello' --dry-run
```

Method `a.b.c` is `slack a b c`. Flags are Slack's argument names
(`--thread_ts`); an argument named like a CLI flag (`format`, `schema`) is
`--slack_<name>`. A few resource ids are positionals, shown in the `Usage:`
line of `--help`. Each command's `--help` lists its arguments with defaults
and examples, user token scopes, rate limit tier, response fields, and a
reference link.

Output is Slack's JSON (TOON by default, `--json` for JSON). Each call returns
one page; pass `response_metadata.next_cursor` as `--cursor` (or the next
`--page` for search) to continue. `--filter-output messages[0].text` and
`--token-limit 2000` keep output small.

Commands that change state accept `--dry-run`, which validates the arguments
and prints what would be sent without sending it.

Errors go to stderr with Slack's `error` code (or the CLI's, like
`RATE_LIMITED`) and exit:

| Exit | Meaning                                                                                  |
| ---- | ---------------------------------------------------------------------------------------- |
| 0    | Success                                                                                  |
| 1    | Failed; retrying unchanged will not help. A `cta` may name the command to run next       |
| 3    | `retryable: true`; retry later (rate limits, transient failures of reads)                |
| 4    | Log in again; the error's `cta` names the command (`slack login`, `slack login --write`) |

A write that timed out or hit a Slack server error is not marked retryable:
it may have been applied, so check before sending it again.

## Agents

```sh
slack skills add
```

Installs one skill ([`skills/slack/`](skills/slack/SKILL.md)) that tells
coding agents how to use the CLI: find commands with `slack <family>
--llms-full` or `--help`, work from message links, search, read date ranges,
find a channel or person by name, page with `--cursor`, preview writes with
`--dry-run`, and act on exit codes. Reference files it links cover writing
messages and uploading or reading files. Commands that delete,
archive, or revoke are marked `destructive` in `--llms-full` so agents confirm
first. Output gains a `_warnings` array when Slack text looks like a prompt
injection; message text is written by other people and is data, not
instructions.

## Security

- Tokens live only in `~/.config/slack-cli/credentials.json` (mode 0600) or
  in `SLACK_TOKEN`.
- Command output, errors, help, and `--dry-run` never print a token.
- Requests go only to `https://slack.com`. There is no background update
  check; `slack --update` contacts npm only when you run it.
- Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Privacy and terms

The project collects no data: no analytics, no telemetry, and no server
between you and Slack. The source code is the privacy policy and the terms.
The software is provided as is, without warranty of any kind; use it at your
own risk. See the [privacy policy](https://alleneubank.github.io/slack-cli/privacy/)
and [support](https://alleneubank.github.io/slack-cli/support/) pages, whose
source is in [`docs/`](docs/).

## How commands are generated

```sh
nub run sync-catalog
```

Regenerates `src/catalog.json` from Slack's method reference at
`https://docs.slack.dev/reference/methods` and fails on a page it cannot
parse. The catalog is committed, so each sync is a reviewable diff, and the
CLI never fetches the docs at runtime. `src/overlay.ts` holds the few facts
the reference does not state (positional ids, mutating methods without a
`:write` scope). Bot-only methods are left out because a user token cannot
call them. Method summaries and argument descriptions come from Slack's
documentation.

## Development

The project uses [nub](https://github.com/nubjs/nub) as its package manager
and task runner. A Nix flake and direnv setup provide the toolchain.

```sh
nub install
nub run check   # typecheck, lint, format check
nub run test
nub run knip
nub run jscpd
nub run build
node dist/cli.js --help
scripts/compile-binaries.sh dist-bin darwin-arm64   # needs Bun, version in .bun-version
```

Unit tests inject `fetch` and never call Slack. Behavior that depends on
Slack (request encoding, pagination, token refresh) is checked by hand
against a test workspace. [SPEC.md](SPEC.md) holds the requirements and
design decisions. Changes that affect the published package need a changeset
(`nub run changeset`). GitHub Pages publishes [`docs/`](docs/) (landing,
privacy, support, walkthrough, and the sign-in page) from `main`, so a push to
`main` changes the live sign-in page.

## License

[MIT](LICENSE)
