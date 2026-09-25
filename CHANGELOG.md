# @alleneubank/slack-cli

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
