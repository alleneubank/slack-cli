---
'@alleneubank/slack-cli': minor
---

A workspace keeps the Slack app it signed in through. `slack login --client-id <id>` signs in through a workspace's own app, and a later `slack login` for that workspace reuses the stored client id without `SLACK_CLIENT_ID`; before, it silently moved the workspace back to the shared app, whose history reads Slack caps at 15 messages per call. `--client-id shared` names the shared app. Login prints which app it uses, and `slack login` and `slack workspaces list` report `clientId` and `app` (`shared` or `own`). The app manifest is now `slack-app-manifest.json`.
