// A/B token-usage eval: the slack CLI + skill versus Slack's hosted MCP server.
// Each run is a fresh headless `claude -p` session that sees exactly one Slack surface.
// Usage: node evals/ab/run.ts --tasks evals/ab/tasks/send.local.json [--repeats 5] [--model claude-sonnet-5]
import { spawn } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { printReport, type RunRecord } from './report.ts'

type Arm = 'cli' | 'mcp'

interface Task {
  id: string
  kind: string
  prompt: string
  expect: string[]
}

interface TaskFile {
  workspace: string
  tasks: Task[]
}

interface StreamSummary {
  init:
    | { tools: string[]; skills: string[]; mcpServers: { name: string; status: string }[] }
    | undefined
  result: Record<string, unknown> | undefined
  toolUses: ToolUse[]
  toolResultChars: number
}

interface ToolUse {
  name: string
  command: string | undefined
}

const evalDir = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(evalDir, '../..')
const runTimeoutMs = 10 * 60 * 1000
const repeatsMax = 50

// Both arms run with bypassed permission prompts, as a trusted interactive session would, so
// shell helpers like `date` and loops cost no extra turns. Read-only tasks run against a real
// workspace, so deny rules (which still apply under bypass) block every family that can write,
// whether invoked by name or by absolute path.
const cliWriteCommands = [
  'admin',
  'bookmarks',
  'calls',
  'canvases',
  'chat',
  'dnd',
  'files',
  'login',
  'logout',
  'pins',
  'reactions',
  'reminders',
  'slackLists',
  'stars',
  'usergroups',
  'views',
  'auth revoke',
  'conversations archive',
  'conversations close',
  'conversations create',
  'conversations invite',
  'conversations join',
  'conversations kick',
  'conversations leave',
  'conversations mark',
  'conversations open',
  'conversations rename',
  'conversations setPurpose',
  'conversations setTopic',
  'conversations unarchive',
  'users deletePhoto',
  'users setPhoto',
  'users setPresence',
  'users profile set',
]

function slackCommandDenials(command: string): string[] {
  return [`Bash(slack ${command}:*)`, `Bash(*/slack ${command} *)`]
}

const cliWriteDenials = cliWriteCommands.flatMap(slackCommandDenials)
const slackBinaryDenials = ['Bash(slack:*)', 'Bash(*/slack *)']

const mcpWriteDenials = [
  'slack_add_list_record',
  'slack_add_reaction',
  'slack_complete_file_upload',
  'slack_create_canvas',
  'slack_create_conversation',
  'slack_create_list',
  'slack_get_file_upload_url',
  'slack_schedule_message',
  'slack_send_message',
  'slack_send_message_draft',
  'slack_update_canvas',
  'slack_update_list',
  'slack_update_list_record',
].map((tool) => `mcp__slack__${tool}`)

const commonDenied = ['WebFetch', 'WebSearch', 'Task', 'Agent', 'Write', 'Edit', 'NotebookEdit']

function parseOptions() {
  const { values } = parseArgs({
    options: {
      tasks: { type: 'string' },
      arms: { type: 'string', default: 'cli,mcp' },
      only: { type: 'string' },
      repeats: { type: 'string', default: '5' },
      model: { type: 'string', default: 'claude-sonnet-5' },
      'budget-usd': { type: 'string', default: '1' },
      'mcp-config': { type: 'string', default: join(evalDir, 'slack-mcp.json') },
      out: { type: 'string' },
    },
  })
  if (values.tasks === undefined) throw new Error('--tasks <file> is required')
  const arms = values.arms.split(',').map((arm) => {
    if (arm !== 'cli' && arm !== 'mcp') throw new Error(`unknown arm: ${arm}`)
    return arm
  })
  const repeats = Number(values.repeats)
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > repeatsMax) {
    throw new Error(`--repeats must be an integer in 1..${repeatsMax}`)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return {
    tasksPath: resolve(values.tasks),
    arms,
    only: values.only?.split(','),
    repeats,
    model: values.model,
    budgetUsd: values['budget-usd'],
    mcpConfigPath: resolve(values['mcp-config']),
    outDir: resolve(values.out ?? join(evalDir, 'results', stamp)),
  }
}

type Options = ReturnType<typeof parseOptions>

// Each arm works in a fresh temp directory outside any git repository, so neither session sees
// this checkout's git context, and only the CLI arm discovers the slack skill.
function prepareArmDir(options: Options, arm: Arm): string {
  const dir = mkdtempSync(join(tmpdir(), `slack-ab-${arm}-`))
  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
  if (arm === 'cli') {
    symlinkSync(join(repoDir, 'skills', 'slack'), join(dir, '.claude', 'skills', 'slack'))
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
  } else {
    writeFileSync(join(dir, 'mcp.json'), readFileSync(options.mcpConfigPath))
  }
  return dir
}

function claudeArgs(options: Options, arm: Arm, task: Task, armDir: string): string[] {
  const denied = [
    ...commonDenied,
    ...(arm === 'cli' ? cliWriteDenials : [...mcpWriteDenials, ...slackBinaryDenials]),
  ]
  return [
    '-p',
    task.prompt,
    '--model',
    options.model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--mcp-config',
    join(armDir, 'mcp.json'),
    '--max-budget-usd',
    options.budgetUsd,
    '--permission-mode',
    'bypassPermissions',
    '--disallowedTools',
    ...denied,
  ]
}

function armEnv(arm: Arm, workspace: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.SLACK_WORKSPACE
  delete env.SLACK_TOKEN
  if (arm === 'cli') {
    env.SLACK_WORKSPACE = workspace
    env.PATH = `${join(repoDir, 'node_modules', '.bin')}:${env.PATH ?? ''}`
  }
  return env
}

function runClaude(args: string[], cwd: string, env: NodeJS.ProcessEnv, streamPath: string) {
  const fd = openSync(streamPath, 'w')
  const child = spawn('claude', args, {
    cwd,
    env,
    stdio: ['ignore', fd, 'inherit'],
    timeout: runTimeoutMs,
  })
  return new Promise<{ exitCode: number | null; timedOut: boolean }>((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('close', (exitCode, signal) => {
      closeSync(fd)
      resolvePromise({ exitCode, timedOut: signal === 'SIGTERM' })
    })
  })
}

function toolResultChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce(
    (sum: number, part) => sum + (typeof part?.text === 'string' ? part.text.length : 0),
    0,
  )
}

function summarizeStream(streamPath: string): StreamSummary {
  const summary: StreamSummary = {
    init: undefined,
    result: undefined,
    toolUses: [],
    toolResultChars: 0,
  }
  for (const line of readFileSync(streamPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const event = JSON.parse(line)
    if (event.type === 'system' && event.subtype === 'init') {
      summary.init = { tools: event.tools, skills: event.skills, mcpServers: event.mcp_servers }
    } else if (event.type === 'result') {
      summary.result = event
    } else if (event.type === 'assistant' && (event.parent_tool_use_id ?? null) === null) {
      for (const part of event.message.content) {
        if (part.type === 'tool_use') {
          summary.toolUses.push({ name: part.name, command: part.input?.command })
        }
      }
    } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const part of event.message.content) {
        if (part.type === 'tool_result') summary.toolResultChars += toolResultChars(part.content)
      }
    }
  }
  return summary
}

// Returns why the session did not see exactly the intended Slack surface, or undefined when it did.
function surfaceMismatch(arm: Arm, init: StreamSummary['init']): string | undefined {
  if (init === undefined) return 'no init event'
  const slackMcpTools = init.tools.filter((tool) => tool.startsWith('mcp__slack__'))
  const hasSkill = init.skills.includes('slack')
  if (arm === 'cli') {
    if (init.mcpServers.length > 0)
      return `cli arm loaded MCP servers: ${init.mcpServers.map((s) => s.name)}`
    if (!hasSkill) return 'cli arm is missing the slack skill'
    return undefined
  }
  if (hasSkill) return 'mcp arm loaded the slack skill'
  if (slackMcpTools.length === 0) {
    return `mcp arm has no mcp__slack__ tools; servers: ${JSON.stringify(init.mcpServers)}`
  }
  return undefined
}

const slackShellInvocation = /(^|[\s;|&(/])slack\s/

// Calls that reached for the other arm's surface; deny rules block them, but they still cost turns.
function crossSurfaceCalls(arm: Arm, toolUses: ToolUse[]): number {
  if (arm === 'cli') return toolUses.filter((use) => use.name.startsWith('mcp__')).length
  return toolUses.filter(
    (use) => use.command !== undefined && slackShellInvocation.test(use.command),
  ).length
}

function grade(task: Task, answer: string): string[] {
  return task.expect.filter((pattern) => !new RegExp(pattern, 'im').test(answer))
}

async function runOne(
  options: Options,
  taskFile: TaskFile,
  task: Task,
  arm: Arm,
  repeat: number,
  armDir: string,
) {
  const streamPath = join(options.outDir, 'streams', `${task.id}.${arm}.${repeat}.jsonl`)
  const { exitCode, timedOut } = await runClaude(
    claudeArgs(options, arm, task, armDir),
    armDir,
    armEnv(arm, taskFile.workspace),
    streamPath,
  )
  const stream = summarizeStream(streamPath)
  const result = stream.result ?? {}
  const usage = (result.usage ?? {}) as Record<string, number>
  const answer = typeof result.result === 'string' ? result.result : ''
  const missing = grade(task, answer)
  const record: RunRecord = {
    task: task.id,
    kind: task.kind,
    arm,
    repeat,
    model: options.model,
    surfaceError: surfaceMismatch(arm, stream.init),
    exitCode,
    timedOut,
    subtype: String(result.subtype ?? 'missing'),
    passed: missing.length === 0 && result.is_error === false,
    missing,
    inputTokens: usage.input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    costUsd: Number(result.total_cost_usd ?? 0),
    turns: Number(result.num_turns ?? 0),
    durationMs: Number(result.duration_ms ?? 0),
    toolCalls: stream.toolUses.length,
    crossSurfaceCalls: crossSurfaceCalls(arm, stream.toolUses),
    toolResultChars: stream.toolResultChars,
    permissionDenials: Array.isArray(result.permission_denials)
      ? result.permission_denials.length
      : 0,
    stream: streamPath,
  }
  appendFileSync(join(options.outDir, 'runs.jsonl'), `${JSON.stringify(record)}\n`)
  return record
}

async function main() {
  const options = parseOptions()
  const taskFile = JSON.parse(readFileSync(options.tasksPath, 'utf8')) as TaskFile
  const tasks = taskFile.tasks.filter((task) => options.only?.includes(task.id) ?? true)
  if (tasks.length === 0) throw new Error('no tasks selected')
  mkdirSync(join(options.outDir, 'streams'), { recursive: true })
  const armDirs = new Map(options.arms.map((arm) => [arm, prepareArmDir(options, arm)]))

  const records: RunRecord[] = []
  for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
    // Alternate which arm goes first so time-of-day and cache warmth do not favor one arm.
    const arms = repeat % 2 === 0 ? options.arms.toReversed() : options.arms
    for (const task of tasks) {
      for (const arm of arms) {
        const record = await runOne(options, taskFile, task, arm, repeat, armDirs.get(arm)!)
        records.push(record)
        const status = record.surfaceError ? 'INVALID' : record.passed ? 'pass' : 'FAIL'
        console.error(
          `[${repeat}/${options.repeats}] ${task.id} ${arm}: ${status} $${record.costUsd.toFixed(4)}`,
        )
        if (record.surfaceError)
          throw new Error(`${arm} arm surface check failed: ${record.surfaceError}`)
      }
    }
  }
  printReport(records)
  console.error(`runs: ${join(options.outDir, 'runs.jsonl')}`)
}

await main()
