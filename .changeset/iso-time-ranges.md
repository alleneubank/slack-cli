---
'@alleneubank/slack-cli': minor
---

Time-range flags (`--oldest`, `--latest`, `--ts_from`, `--ts_to`) accept ISO 8601 dates and times as well as Unix seconds. The skill now covers message links, date ranges, search, and lookups by name inline, lists the positional ids, and runs `slack workspaces list` only when the workspace is in doubt.
