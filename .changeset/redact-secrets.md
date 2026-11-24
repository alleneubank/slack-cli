---
'@alleneubank/slack-cli': minor
---

Tokens and secrets in Slack's responses are no longer printed. Any string under `token` or a key ending in `_token` or `_secret`, at any depth, is shown as `[redacted]`, and the response lists the replaced paths in `redacted`. This covers `apps manifest create` (the new app's client secret, signing secret, and verification token) and the `oauth`, `openid`, and `tooling` methods that return tokens. `apps manifest create --help` now points to `slack app create`.
