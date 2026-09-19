# @alleneubank/slack-cli

## 0.2.0

### Minor Changes

- 335ee52: `slack login` signs in through an HTTPS redirect page, https://alleneubank.github.io/slack-cli/callback/, which hands the one-time code to the CLI on your computer; Slack requires HTTPS redirects to distribute an app, so logins from 0.1.0 no longer work against the project's app. New `slack login --paste` shows the code in the browser and reads it from the terminal, for machines the browser cannot reach (SSH). New logins store long-lived tokens; rotating tokens stored by 0.1.0 still refresh.

## 0.1.0

### Minor Changes

- Initial release. Every Slack Web API method a user token can call is a typed command, generated from Slack's public method reference. Sign-in is public OAuth with PKCE; rotating tokens are stored per workspace and refreshed automatically. The CLI collects no data and talks only to slack.com. Not affiliated with Slack.
