// Aggregates A/B runs into a per-task, per-arm markdown table of medians.
// Usage: node evals/ab/report.ts evals/ab/results/<run>/runs.jsonl [...more runs.jsonl]
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface RunRecord {
  task: string
  kind: string
  arm: 'cli' | 'mcp'
  repeat: number
  model: string
  surfaceError: string | undefined
  exitCode: number | null
  timedOut: boolean
  subtype: string
  passed: boolean
  missing: string[]
  inputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  outputTokens: number
  costUsd: number
  turns: number
  durationMs: number
  toolCalls: number
  toolResultChars: number
  crossSurfaceCalls: number
  permissionDenials: number
  stream: string
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function contextTokens(record: RunRecord): number {
  return record.inputTokens + record.cacheCreationTokens + record.cacheReadTokens
}

function row(label: string, arm: string, records: RunRecord[]): string {
  const passed = records.filter((record) => record.passed).length
  const cells = [
    label,
    arm,
    `${passed}/${records.length}`,
    median(records.map(contextTokens)).toFixed(0),
    median(records.map((record) => record.outputTokens)).toFixed(0),
    `$${median(records.map((record) => record.costUsd)).toFixed(4)}`,
    median(records.map((record) => record.turns)).toFixed(1),
    median(records.map((record) => record.toolCalls)).toFixed(1),
    median(records.map((record) => record.toolResultChars)).toFixed(0),
    `${(median(records.map((record) => record.durationMs)) / 1000).toFixed(1)}s`,
  ]
  return `| ${cells.join(' | ')} |`
}

export function printReport(records: RunRecord[]): void {
  const valid = records.filter((record) => record.surfaceError === undefined)
  const tasks = [...new Set(valid.map((record) => record.task))]
  const arms = [...new Set(valid.map((record) => record.arm))].toSorted()
  const lines = [
    '| task | arm | pass | ctx tokens | out tokens | cost | turns | tool calls | tool result chars | time |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const task of tasks) {
    for (const arm of arms) {
      const group = valid.filter((record) => record.task === task && record.arm === arm)
      if (group.length > 0) lines.push(row(task, arm, group))
    }
  }
  // The pooled row takes medians over every work-task run, excluding the overhead baseline.
  for (const arm of arms) {
    const work = valid.filter((record) => record.arm === arm && record.kind !== 'overhead')
    if (work.length > 0) lines.push(row('**all work tasks**', arm, work))
  }
  for (const arm of arms) {
    const armRecords = valid.filter((record) => record.arm === arm)
    const sum = (field: 'permissionDenials' | 'crossSurfaceCalls') =>
      armRecords.reduce((total, record) => total + (record[field] ?? 0), 0)
    lines.push(
      `\n${arm}: ${sum('permissionDenials')} permission denials, ${sum('crossSurfaceCalls')} calls to the other arm's surface`,
    )
  }
  console.log(lines.join('\n'))
  const invalid = records.length - valid.length
  if (invalid > 0) console.log(`\n${invalid} run(s) excluded for surface mismatch.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2)
  if (paths.length === 0) throw new Error('pass one or more runs.jsonl paths')
  const records = paths.flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as RunRecord),
  )
  printReport(records)
}
