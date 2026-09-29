// `agent-bridge repl`: the batch loop with a prompt.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import { type CallOutcome, parseBatchLine, runCall } from './batch'
import type { AgentBridge } from './index'
import { logLine } from './log-lines'
import { renderResult } from './output'

export const HISTORY_LIMIT = 500
export const DEFAULT_HISTORY_FILE = join(
  homedir(),
  '.agent-bridge',
  'repl_history',
)

export const DOT_COMMANDS = [
  '.help',
  '.tools',
  '.time',
  '.pending',
  '.restore',
  '.exit',
]

const HELP = `Type a call the way \`agent-bridge call\` takes it: tool [args]
  screen.press "Save"          one JSON value is one argument
  store.set ["user", {"a":1}]   a JSON array is the argument list
Dot commands
  .tools [prefix]     List tools, optionally starting with prefix
  .time <call> [xN]   Run a call N times (default 10); min/median/max
  .pending            bridge.pending: what bridge.restore would undo
  .restore            bridge.restore
  .help               This text
  .exit               Leave (also Ctrl-D)
Tab completes tool names and dot commands.`

/** Tab completion for the line so far: dot commands at the start, tool names after a dot command or as the first word. */
export function complete(
  line: string,
  toolNames: string[],
): [string[], string] {
  const first = /^\s*(\S*)$/.exec(line)
  if (first) {
    const word = first[1] as string
    const pool = word.startsWith('.') ? DOT_COMMANDS : toolNames
    return [pool.filter((n) => n.startsWith(word)), word]
  }
  const arg = /^\s*\.(?:tools|time)\s+(\S*)$/.exec(line)
  if (arg) {
    const word = arg[1] as string
    return [toolNames.filter((n) => n.startsWith(word)), word]
  }
  return [[], line]
}

export function loadHistory(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** Keeps the newest `limit` lines. Failure to save is not worth interrupting the session for. */
export function saveHistory(file: string, lines: string[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${lines.slice(-HISTORY_LIMIT).join('\n')}\n`, {
      mode: 0o600,
    })
  } catch {}
}

const median = (sorted: number[]) => {
  const mid = sorted.length >> 1
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const f = (n: number) => n.toFixed(1)
  return `min ${f(sorted[0] as number)} / median ${f(median(sorted))} / max ${f(sorted.at(-1) as number)} ms`
}

export type ReplOptions = {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream & { isTTY?: boolean }
  /** Whether input is a terminal: line editing, the prompt and colours. */
  tty?: boolean
  historyFile?: string
  full?: boolean
}

export async function runRepl(
  bridge: Pick<AgentBridge, 'timed' | 'tools'>,
  options: ReplOptions,
): Promise<void> {
  const { output } = options
  const tty = !!options.tty
  const historyFile = options.historyFile ?? DEFAULT_HISTORY_FILE
  const persist = tty || options.historyFile !== undefined
  const paint = (code: number, text: string) =>
    tty && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text
  const print = (text = '') => output.write(`${text}\n`)
  const toolNames = () => bridge.tools().map((t) => t.name)

  const history = loadHistory(historyFile)
  const rl = createInterface({
    input: options.input,
    output,
    terminal: tty,
    prompt: tty ? 'agent-bridge> ' : '',
    history: [...history].reverse(),
    historySize: HISTORY_LIMIT,
    completer: (line: string) => complete(line, toolNames()),
  })
  const entered: string[] = [...history]
  let closed = false
  rl.once('close', () => {
    closed = true
  })
  const prompt = () => {
    if (!closed) rl.prompt()
  }

  const show = async (outcome: CallOutcome) => {
    for (const e of outcome.logs) print(paint(2, logLine(e)))
    if (outcome.notice) print(paint(33, `Warning: ${outcome.notice}`))
    if (!outcome.ok) {
      print(paint(31, outcome.error ?? 'failed'))
      return
    }
    print(await renderResult(outcome.value, { full: options.full }))
    print(
      paint(
        2,
        `${outcome.ms.toFixed(1)} ms round trip, ${outcome.appMs} ms in the app`,
      ),
    )
  }

  const time = async (rest: string) => {
    const m = /^(.*?)(?:\s+x(\d+))?$/.exec(rest.trim())
    const parsed = parseBatchLine(m?.[1] ?? '')
    if (!parsed) return print('Usage: .time <tool> [args] [xN]')
    const runs = Math.max(1, Number(m?.[2] ?? 10))
    const trips: number[] = []
    const inApp: number[] = []
    for (let i = 0; i < runs; i++) {
      const outcome = await runCall(bridge, parsed)
      if (!outcome.ok) return show(outcome)
      trips.push(outcome.ms)
      inApp.push(outcome.appMs ?? 0)
    }
    print(`${parsed.tool} x${runs}`)
    print(`  round trip  ${stats(trips)}`)
    print(`  in the app  ${stats(inApp)}`)
  }

  const dot = async (line: string): Promise<boolean> => {
    const [name = '', ...more] = line.split(/\s+/)
    const rest = line.slice(name.length).trim()
    switch (name) {
      case '.exit':
        return false
      case '.help':
        print(HELP)
        break
      case '.tools': {
        const list = bridge
          .tools()
          .filter((t) => t.name.startsWith(more[0] ?? ''))
        if (!list.length) print('No tools match.')
        for (const t of list)
          print(`  ${t.name.padEnd(22)} ${t.description ?? ''}`)
        break
      }
      case '.time':
        await time(rest)
        break
      case '.pending':
        await show(await runCall(bridge, { tool: 'bridge.pending', args: [] }))
        break
      case '.restore':
        await show(await runCall(bridge, { tool: 'bridge.restore', args: [] }))
        break
      default:
        print(paint(31, `Unknown command ${name}. Try .help`))
    }
    return true
  }

  if (tty) print('agent-bridge repl. .help for commands, .exit or Ctrl-D to leave.')
  prompt()
  try {
    for await (const raw of rl) {
      const line = raw.trim()
      if (line && !line.startsWith('#')) {
        entered.push(line)
        if (line.startsWith('.')) {
          if (!(await dot(line))) break
        } else {
          const parsed = parseBatchLine(line)
          if (parsed) await show(await runCall(bridge, parsed))
        }
      }
      prompt()
    }
  } finally {
    rl.close()
    if (persist) saveHistory(historyFile, entered)
  }
}
