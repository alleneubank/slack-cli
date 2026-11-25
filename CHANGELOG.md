# @alleneubank/slack-cli

## 0.7.0

### Minor Changes

- eab4dc5: New `slack app update` adds the user scopes, redirect, and PKCE setting that this release's `slack login` needs to a workspace's own Slack app, reading an app configuration token from a hidden prompt or stdin. It keeps the app's name, icon, and other scopes, and changes nothing when the app already matches. `slack app create` now stores the app id with the workspace (shown by `slack workspaces list`), and `slack app update --app A…` covers apps made by hand. When Slack refuses a login with "Invalid permissions requested", the redirect page and the login's timeout error now point to `slack app update`.
- 6a33bcb: GitHub releases now carry standalone `slack` executables for macOS (arm64, x64) and Linux (x64, arm64), built with Bun, with `SHA256SUMS` and a build provenance attestation. They need no Node.js and start in about a twentieth of the time. The npm package is unchanged.
- 76eeab0: Tokens and secrets in Slack's responses are no longer printed. Any string under `token` or a key ending in `_token` or `_secret`, at any depth, is shown as `[redacted]`, and the response lists the replaced paths in `redacted`. This covers `apps manifest create` (the new app's client secret, signing secret, and verification token) and `apps auth external get`.

  The methods that exist to return a credential for an app's own OAuth server or token rotation are no longer commands: `oauth access`, `oauth v2 access`, `oauth v2 user access`, `oauth v2 exchange`, `oauth v2 beginShortTokenRotation`, `oauth v2 completeShortTokenRotation`, `openid connect token`, and `tooling tokens rotate`. Slack consumes the code or token they take, so a redacted answer would be lost. `slack login` and `slack app create` cover what this CLI needs from them. `apps manifest create --help` now points to `slack app create`.

### Patch Changes

- 4e5fd1d: A `slack login` started while another is waiting for consent on port 8912 now fails with `LOGIN_IN_PROGRESS` before it prints the authorize URL or opens the browser. Before, it opened the browser and then crashed with `EADDRINUSE`.
- 3e724cc: OAuth token requests (login and refresh) and file downloads and uploads now end at their deadline even when Slack's response stalls after its headers, as Web API calls already did. Before, a stalled token refresh or download could hang until the server closed the connection.

## 0.6.0

### Minor Changes

- 55384dd: New `slack app create [--write]` creates a workspace's own Slack app from the bundled manifest and signs the workspace in through it, so history reads are not capped like the shared app's. It reads an app configuration token from a hidden prompt or stdin, uses it for that one `apps.manifest.create` call, and never stores or prints it or the new app's secrets.
- 4258556: A workspace keeps the Slack app it signed in through. `slack login --client-id <id>` signs in through a workspace's own app, and a later `slack login` for that workspace reuses the stored client id without `SLACK_CLIENT_ID`; before, it silently moved the workspace back to the shared app, whose history reads Slack caps at 15 messages per call. `--client-id shared` names the shared app. Login prints which app it uses, and `slack login` and `slack workspaces list` report `clientId` and `app` (`shared` or `own`). The app manifest is now `slack-app-manifest.json`.

### Patch Changes

- ecf0cb5: A Slack response cut off or timed out after its headers is now a `NETWORK` or `TIMEOUT` failure like one lost before them: retryable for reads, and for writes it says the write may have been applied. Before, it surfaced as `UNKNOWN`. The 30-second request deadline now also ends a response body that stalls, which could hang until Slack closed the connection.

## 0.5.0

### Minor Changes

- 3805154: New `slack files download <file id | message link>` saves a file, or every file on a linked message, with the stored login; the token goes only to `https://*.slack.com` and is never printed. `slack files upload <paths...> --channel <id | message link>` uploads and shares files, in a thread when given a link, replacing the command for Slack's retired `files.upload` method.

## 0.4.0

### Minor Changes

- 1726644: `--json` output is compact single-line JSON when stdout is not a terminal (agents, pipes) and stays indented in a terminal, via `@alleneubank/incur` 0.9.0.
- c2d5827: Time-range flags (`--oldest`, `--latest`, `--ts_from`, `--ts_to`) accept ISO 8601 dates and times as well as Unix seconds. The skill now covers message links, date ranges, search, and lookups by name inline, lists the positional ids, and runs `slack workspaces list` only when the workspace is in doubt.
- 60140ba: Commands that take `<channel> <ts>` (`chat delete`, `chat getPermalink`, `chat update`, `conversations replies`) accept a single Slack message link instead; `conversations replies` follows the link's `thread_ts` to the thread. `conversations history` takes a link for `<channel>` and reads only that message unless `--oldest`, `--latest`, `--inclusive`, or `--limit` is given. A malformed link fails with `INVALID_ARGUMENT` before any request.
- d0aff4c: `slack workspaces list` leaves out granted scopes unless `--scopes` is passed; they were most of its output.

### Patch Changes

- e758ac3: Keep login waiting after an unrelated OAuth callback, and direct rejected `SLACK_TOKEN` users to fix or unset the override.

## 0.3.0

### Minor Changes

- 6a65e8a: `slack login` requests every user scope a command needs that Slack lets the app request, so commands such as `team profile get`, `team info`, `usergroups list`, `pins add`, and `reminders add` work after signing in again. Plain `slack login` stays read-only; `slack login --write` adds the write scopes. Run `slack login` (or `slack login --write`) again to pick them up.

### Patch Changes

- 14293f1: The agent skill covers uploading and sharing files, working from message links, threads, DMs, Slack's mrkdwn formatting, and finding channels and people by name, in reference files that `slack skills add` installs beside `SKILL.md`. `slack files upload --help` says Slack retired the method and names the three-step replacement. Passing a positional as a flag (`slack chat delete --channel C…`) says the argument is positional.

## 0.2.0

### Minor Changes

- 335ee52: `slack login` signs in through an HTTPS redirect page, https://alleneubank.github.io/slack-cli/callback/, which hands the one-time code to the CLI on your computer; Slack requires HTTPS redirects to distribute an app, so logins from 0.1.0 no longer work against the project's app. New `slack login --paste` shows the code in the browser and reads it from the terminal, for machines the browser cannot reach (SSH). New logins store long-lived tokens; rotating tokens stored by 0.1.0 still refresh.

## 0.1.0

### Minor Changes

- Initial release. Every Slack Web API method a user token can call is a typed command, generated from Slack's public method reference. Sign-in is public OAuth with PKCE; rotating tokens are stored per workspace and refreshed automatically. The CLI collects no data and talks only to slack.com. Not affiliated with Slack.
