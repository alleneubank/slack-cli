---
'@alleneubank/slack-cli': minor
---

New `slack app create [--write]` creates a workspace's own Slack app from the bundled manifest and signs the workspace in through it, so history reads are not capped like the shared app's. It reads an app configuration token from a hidden prompt or stdin, uses it for that one `apps.manifest.create` call, and never stores or prints it or the new app's secrets.
