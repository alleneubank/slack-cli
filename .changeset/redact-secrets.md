---
'@alleneubank/slack-cli': minor
---

Tokens and secrets in Slack's responses are no longer printed. Any string under `token` or a key ending in `_token` or `_secret`, at any depth, is shown as `[redacted]`, and the response lists the replaced paths in `redacted`. This covers `apps manifest create` (the new app's client secret, signing secret, and verification token) and `apps auth external get`.

The methods that exist to return a credential for an app's own OAuth server or token rotation are no longer commands: `oauth access`, `oauth v2 access`, `oauth v2 user access`, `oauth v2 exchange`, `oauth v2 beginShortTokenRotation`, `oauth v2 completeShortTokenRotation`, `openid connect token`, and `tooling tokens rotate`. Slack consumes the code or token they take, so a redacted answer would be lost. `slack login` and `slack app create` cover what this CLI needs from them. `apps manifest create --help` now points to `slack app create`.
