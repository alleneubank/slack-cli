# Privacy and terms

This covers the `slack` command from `@alleneubank/slack-cli` and its Slack app,
"CLI for Slack (unofficial)". The project is not made, affiliated with, or
endorsed by Slack Technologies, LLC.

## Privacy

The project collects no data.

- **Public PKCE sign-in.** `slack login` uses OAuth 2.0 with PKCE and a
  loopback redirect to your own computer (`http://127.0.0.1:8912/callback`).
  The app has no client secret and there is no server run by this project.
  Slack sends the authorization code to your computer, and the CLI exchanges
  it with Slack directly.
- **Your tokens stay on your computer**, in
  `~/.config/slack-cli/credentials.json` (mode 0600), or in `SLACK_TOKEN` if
  you set it. The CLI never prints them.
- **The CLI talks only to Slack.** Every request goes to `https://slack.com`.
  There is no analytics, telemetry, crash reporting, or background update
  check. `slack --update` contacts the npm registry only when you run it.
- **Nothing reaches the developers.** They never receive your tokens,
  messages, files, or any other workspace data.
- **Removing it:** `slack logout --all` deletes the stored tokens,
  `slack auth revoke` revokes the current token at Slack, and a workspace
  admin can remove the app from the workspace's app settings.

## Terms

The source code at <https://github.com/alleneubank/slack-cli> is the privacy
policy and the terms: what it does is exactly what the code does.

The software is released under the [MIT License](LICENSE) and is provided "as
is", without warranty of any kind. Use it at your own risk. The authors are not
liable for any claim, damages, or other liability arising from its use. Your
use of Slack remains subject to Slack's own terms and your workspace's
policies.
