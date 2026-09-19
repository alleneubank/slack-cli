---
'@alleneubank/slack-cli': minor
---

`slack login` requests every user scope a command needs that Slack lets the app request, so commands such as `team profile get`, `team info`, `usergroups list`, `pins add`, and `reminders add` work after signing in again. Plain `slack login` stays read-only; `slack login --write` adds the write scopes. Run `slack login` (or `slack login --write`) again to pick them up.
