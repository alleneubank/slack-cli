# Slack CLI vs Slack MCP token eval

Runs the same read-only Slack tasks through two arms and compares token usage,
cost, turns, and correctness:

- `cli`: the `slack` CLI from this checkout plus the `skills/slack` skill.
- `mcp`: Slack's hosted MCP server (`slack-mcp.json`), with `slack` Bash calls denied.

Each run is a fresh `claude -p` session with `--setting-sources project` and
`--strict-mcp-config`, so user plugins and other MCP servers stay out of both
arms. Sessions start in a temp directory outside any git repository, so neither
arm sees this checkout. The runner checks each session's init event and stops if
an arm sees the wrong Slack surface.

Both arms run with `--permission-mode bypassPermissions` so shell helpers
(`date`, loops, redirects) cost no denied turns, as in a trusted interactive
session. Deny rules still apply under bypass: write-capable CLI families (by
name or absolute path) and MCP write tools are denied. Denied MCP tools drop out
of the session's tool list, so the MCP arm does not pay for write-tool schemas.
The report counts permission denials and calls to the other arm's surface.

## Setup

1. Authorize the MCP arm once, choosing the workspace the tasks target:

   ```sh
   claude --strict-mcp-config --mcp-config evals/ab/slack-mcp.json
   # then run /mcp, select slack, and authenticate
   ```

   The workspace admin must have approved the Slack MCP integration.

2. Log in to the same workspace with the CLI (`slack login`).

3. Write a task file. Files named `tasks/*.local.json` are gitignored because
   tasks and answers quote private workspace content:

   ```json
   {
     "workspace": "T0123456789",
     "tasks": [
       {
         "id": "baseline",
         "kind": "overhead",
         "prompt": "Reply with exactly: OK",
         "expect": ["^\\s*OK\\s*$"]
       },
       { "id": "lookup", "kind": "users", "prompt": "…", "expect": ["regex that must match", "…"] }
     ]
   }
   ```

   A run passes when every `expect` regex matches the final answer
   (case-insensitive). Tasks of kind `overhead` measure fixed context cost and
   are left out of the pooled row. Pin questions to past timestamps so answers
   do not drift.

## Run

```sh
node evals/ab/run.ts --tasks evals/ab/tasks/send.local.json --repeats 5 --model claude-sonnet-5
node evals/ab/report.ts evals/ab/results/<run>/runs.jsonl
```

Options: `--arms cli,mcp`, `--only task1,task2`, `--budget-usd 1` (per run),
`--out <dir>`. Arms alternate order between repeats. Raw stream-json for every
run lands in `results/<run>/streams/` for reading transcripts.
