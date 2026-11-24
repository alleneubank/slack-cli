---
'@alleneubank/slack-cli': minor
---

New `slack app update` adds the user scopes, redirect, and PKCE setting that this release's `slack login` needs to a workspace's own Slack app, reading an app configuration token from a hidden prompt or stdin. It keeps the app's name, icon, and other scopes, and changes nothing when the app already matches. `slack app create` now stores the app id with the workspace (shown by `slack workspaces list`), and `slack app update --app A…` covers apps made by hand. When Slack refuses a login with "Invalid permissions requested", the redirect page and the login's timeout error now point to `slack app update`.
