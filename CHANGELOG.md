# @alleneubank/slack-cli

## 0.1.0

### Minor Changes

- Initial release. Every Slack Web API method a user token can call is a typed command, generated from Slack's public method reference. Sign-in is public OAuth with PKCE; rotating tokens are stored per workspace and refreshed automatically. The CLI collects no data and talks only to slack.com. Not affiliated with Slack.
