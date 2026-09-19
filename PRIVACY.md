# Privacy and terms

The privacy policy and terms are published at
<https://alleneubank.github.io/slack-cli/privacy/>, from
[`docs/privacy/index.html`](docs/privacy/index.html) in this repository.

In short:

- The project collects no data. It has no server, analytics, or telemetry,
  and the CLI does not check for updates in the background.
- `slack login` uses public OAuth with PKCE. Slack sends a one-time code to
  the static page at <https://alleneubank.github.io/slack-cli/callback/>,
  which hands it to the CLI on your computer; the code is useless without the
  PKCE verifier that never leaves your computer.
- Your token is stored only on your computer, in
  `~/.config/slack-cli/credentials.json` (mode 0600), and requests go only to
  `https://slack.com`.
- The source code is the privacy policy and the terms. The software is MIT
  licensed and provided "as is", without warranty of any kind; use it at your
  own risk.

Contact: <allen@unrulysystems.com>.
