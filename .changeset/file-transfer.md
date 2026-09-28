---
'@alleneubank/slack-cli': minor
---

New `slack files download <file id | message link>` saves a file, or every file on a linked message, with the stored login; the token goes only to `https://*.slack.com` and is never printed. `slack files upload <paths...> --channel <id | message link>` uploads and shares files, in a thread when given a link, replacing the command for Slack's retired `files.upload` method.
