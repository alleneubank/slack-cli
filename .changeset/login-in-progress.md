---
'@alleneubank/slack-cli': patch
---

A `slack login` started while another is waiting for consent on port 8912 now fails with `LOGIN_IN_PROGRESS` before it prints the authorize URL or opens the browser. Before, it opened the browser and then crashed with `EADDRINUSE`.
