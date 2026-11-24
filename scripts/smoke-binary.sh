#!/usr/bin/env bash
# Smoke-tests a compiled `slack` from an unpacked release archive.
#
#   scripts/smoke-binary.sh <path to bin/slack> <expected version>
#
# Runs with an empty HOME. The fake tokens are not credentials; Slack must
# answer them with invalid_auth, which proves the request reached Slack.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <path to bin/slack> <expected version>" >&2
  exit 2
fi
slack=$1
expected=$2
HOME=$(mktemp -d)
export HOME
trap 'rm -r "$HOME"' EXIT

fail() {
  echo "smoke test failed: $1" >&2
  exit 1
}

version=$("$slack" --version)
[[ $version == "$expected" ]] || fail "--version printed $version, expected $expected"
"$slack" app create --help | grep -q 'configuration token' || fail 'app create --help'
# Both commands exit 1 and print the error on stderr; the error is what is checked.
answer=$(SLACK_TOKEN=xoxp-0-not-a-token "$slack" auth test --json 2>&1 || true)
[[ $answer == *'"code":"invalid_auth"'* ]] ||
  fail "auth test with a fake token did not reach Slack as invalid_auth: $answer"
answer=$(echo 'xoxe.xoxp-0-not-a-token' | "$slack" app create --json 2>&1 || true)
[[ $answer == *'"code":"invalid_auth"'* ]] ||
  fail "app create with a fake configuration token did not reach Slack as invalid_auth: $answer"
"$slack" skills add --json | grep -q '"skills"' || fail 'skills add did not find the bundled skill'
echo "smoke test passed: $slack $version"
