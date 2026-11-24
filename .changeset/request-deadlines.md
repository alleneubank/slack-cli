---
'@alleneubank/slack-cli': patch
---

OAuth token requests (login and refresh) and file downloads and uploads now end at their deadline even when Slack's response stalls after its headers, as Web API calls already did. Before, a stalled token refresh or download could hang until the server closed the connection.
