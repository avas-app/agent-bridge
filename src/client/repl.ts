// `agent-bridge repl`: the batch loop with a prompt.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Interface, createInterface } from 'node:readline'

import {
  type CallOutcome,
  MAX_TIME_RUNS,
  type Spread,
  parseTime,
  runCall,
  runLine,
  spread,
} from './batch'
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
  .time <call> [xN]   Run a call N times (default 10, at most ${MAX_TIME_RUNS}); min/median/max
  .pending            bridge.pending: what bridge.restore would undo
  .restore            bridge.restore
  .help               This text
  .exit               Leave (also Ctrl-D)
Ctrl-C clears the line, or gives up waiting for a running call (the app may still finish it).
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

/** The newest HISTORY_LIMIT lines; rewrites the file when it has grown past that. */
export function loadHistory(file: string): string[] {
  let lines: string[]
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
  if (lines.length <= HISTORY_LIMIT) return lines
  saveHistory(file, lines)
  return lines.slice(-HISTORY_LIMIT)
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

/** One line at a time, so a killed REPL keeps its history and two REPLs don't overwrite each other. */
export function appendHistory(file: string, line: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${line}\n`, { mode: 0o600 })
  } catch {}
}

const fixed = (s: Spread) =>
  `min ${s.min.toFixed(1)} / median ${s.median.toFixed(1)} / max ${s.max.toFixed(1)} ms`

export type ReplOptions = {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  /** Whether input and output are a terminal: line editing, the prompt and colours. */
  tty?: boolean
  /** Where history is kept. Without it nothing is saved. */
  historyFile?: string
  full?: boolean
  /** Called with the readline interface, e.g. to send it a SIGINT in tests. */
  onReady?: (rl: Interface) => void
}

const INTERRUPTED = 'Interrupted. The call may still finish in the app.'

export async function runRepl(
  bridge: Pick<AgentBridge, 'timed' | 'tools'>,
  options: ReplOptions,
): Promise<void> {
  const { output } = options
  const tty = !!options.tty
  const { historyFile } = options
  const paint = (code: number, text: string) =>
    tty && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text
  const print = (text = ''): void => {
    output.write(`${text}\n`)
  }
  const toolNames = () => bridge.tools().map((t) => t.name)

  const history = historyFile ? loadHistory(historyFile) : []
  const rl = createInterface({
    input: options.input,
    output,
    terminal: tty,
    prompt: tty ? 'agent-bridge> ' : '',
    history: [...history].reverse(),
    historySize: HISTORY_LIMIT,
    completer: (line: string) => complete(line, toolNames()),
  })
  let closed = false
  rl.once('close', () => {
    closed = true
  })
  const prompt = () => {
    if (!closed) rl.prompt()
  }

  // Raw mode means Ctrl-C reaches us as readline's SIGINT, not as a signal.
  // Idle: clear the line. Busy: stop waiting and go back to the prompt.
  let giveUp: (() => void) | null = null
  rl.on('SIGINT', () => {
    if (giveUp) return giveUp()
    print('^C')
    if (tty) rl.write(null, { ctrl: true, name: 'u' })
    prompt()
  })

  /** Runs `work` until it ends or Ctrl-C. `live()` turns false after Ctrl-C: check it before printing. */
  const interruptible = async (work: (live: () => boolean) => Promise<void>) => {
    let live = true
    let release!: () => void
    const aborted = new Promise<void>((r) => {
      release = r
    })
    giveUp = () => {
      live = false
      release()
    }
    try {
      await Promise.race([work(() => live), aborted])
    } finally {
      giveUp = null
    }
    if (!live) print(paint(33, INTERRUPTED))
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

  const time = async (rest: string, live: () => boolean) => {
    let request: ReturnType<typeof parseTime>
    try {
      request = parseTime(rest)
    } catch (error) {
      return print(paint(31, error instanceof Error ? error.message : String(error)))
    }
    if (!request) return print('Usage: .time <tool> [args] [xN]')
    const { call, runs } = request
    if (request.capped)
      print(paint(33, `Running ${runs} times: .time is capped at ${MAX_TIME_RUNS}.`))
    const trips: number[] = []
    const inApp: number[] = []
    for (let i = 0; i < runs; i++) {
      if (!live()) return
      const outcome = await runCall(bridge, call)
      if (!live()) return
      if (!outcome.ok) {
        await show(outcome)
        return
      }
      trips.push(outcome.ms)
      inApp.push(outcome.appMs ?? 0)
    }
    print(`${call.tool} x${runs}`)
    print(`  round trip  ${fixed(spread(trips))}`)
    print(`  in the app  ${fixed(spread(inApp))}`)
  }

  const tool = (name: string) => (live: () => boolean) =>
    runCall(bridge, { tool: name, args: [] }).then(
      (outcome) => (live() ? show(outcome) : undefined),
    )

  /** False to leave. */
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
        await interruptible((live) => time(rest, live))
        break
      case '.pending':
        await interruptible(tool('bridge.pending'))
        break
      case '.restore':
        await interruptible(tool('bridge.restore'))
        break
      default:
        print(paint(31, `Unknown command ${name}. Try .help`))
    }
    return true
  }

  options.onReady?.(rl)
  if (tty) print('agent-bridge repl. .help for commands, .exit or Ctrl-D to leave.')
  prompt()
  let eof = false
  try {
    for await (const raw of rl) {
      const line = raw.trim()
      if (line && !line.startsWith('#')) {
        if (historyFile) appendHistory(historyFile, line)
        if (line.startsWith('.')) {
          if (!(await dot(line))) break
        } else {
          await interruptible(async (live) => {
            const outcome = await runLine(bridge, line)
            if (outcome && live()) await show(outcome)
          })
        }
      }
      prompt()
    }
    eof = closed
  } finally {
    rl.close()
    if (tty && eof) output.write('\n')
  }
}
