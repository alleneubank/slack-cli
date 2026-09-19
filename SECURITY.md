# Security

Report a vulnerability privately through
[GitHub's private vulnerability reporting](https://github.com/alleneubank/slack-cli/security/advisories/new).
Do not open a public issue for it, and do not include real Slack tokens in the
report; a redacted prefix is enough.

In scope: anything that exposes a Slack token, refresh token, or
authorization code (output, logs, files, network), sends credentials anywhere
other than `slack.com`, or lets one workspace's credentials act on another.
The Slack platform itself is out of scope; report those issues to Slack.
