---
'@alleneubank/slack-cli': minor
---

Commands that take `<channel> <ts>` (`chat delete`, `chat getPermalink`, `chat update`, `conversations replies`) accept a single Slack message link instead; `conversations replies` follows the link's `thread_ts` to the thread. `conversations history` takes a link for `<channel>` and reads only that message unless `--oldest`, `--latest`, `--inclusive`, or `--limit` is given. A malformed link fails with `INVALID_ARGUMENT` before any request.
