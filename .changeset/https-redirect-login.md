---
'@alleneubank/slack-cli': minor
---

`slack login` signs in through an HTTPS redirect page, https://alleneubank.github.io/slack-cli/callback/, which hands the one-time code to the CLI on your computer; Slack requires HTTPS redirects to distribute an app, so logins from 0.1.0 no longer work against the project's app. New `slack login --paste` shows the code in the browser and reads it from the terminal, for machines the browser cannot reach (SSH). New logins store long-lived tokens; rotating tokens stored by 0.1.0 still refresh.
