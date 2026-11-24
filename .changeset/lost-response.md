---
'@alleneubank/slack-cli': patch
---

A Slack response cut off or timed out after its headers is now a `NETWORK` or `TIMEOUT` failure like one lost before them: retryable for reads, and for writes it says the write may have been applied. Before, it surfaced as `UNKNOWN`. The 30-second request deadline now also ends a response body that stalls, which could hang until Slack closed the connection.
