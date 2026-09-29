// `agent-bridge call --batch`: many calls over one connection, one JSON line each.
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { shapedResult } from './output'
import { type AgentBridge, AgentBridgeCallError, type LogEntry } from './index'

/** `call`'s argument syntax: a JSON array is the argument list, any other JSON value is the one argument, and text that isn't JSON is a string. */
export function parseCallArgs(raw: string | undefined): unknown[] {
  if (raw === undefined) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return [raw]
  }
  return Array.isArray(value) ? value : [value]
}

export type ParsedLine = { tool: string; args: unknown[] }

/** A line whose arguments look like JSON but aren't: reported, not sent as a string. */
export class BatchParseError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * `tool args` -> the call, or null for a blank line or a `#` comment. Arguments
 * follow `call`, except that text starting like JSON (`[`, `{`, `"`) that does
 * not parse is an error, so a typo doesn't reach the app as a string.
 */
export function parseBatchLine(line: string): ParsedLine | null {
  const text = line.trim()
  if (!text || text.startsWith('#')) return null
  const at = text.search(/\s/)
  if (at < 0) return { tool: text, args: [] }
  const tool = text.slice(0, at)
  const raw = text.slice(at).trim()
  if (/^[[{"]/.test(raw)) {
    try {
      JSON.parse(raw)
    } catch (error) {
      throw new BatchParseError(
        tool,
        `Arguments start like JSON but don't parse (${error instanceof Error ? error.message : error}). Fix the JSON, or quote the text to send it as a string: ${JSON.stringify(raw)}`,
      )
    }
  }
  return { tool, args: parseCallArgs(raw) }
}

export type CallOutcome = {
  tool: string
  ok: boolean
  /** Round trip as the client saw it. */
  ms: number
  /** Time spent inside the app, when the call reached it. */
  appMs?: number
  value?: unknown
  error?: string
  logs: LogEntry[]
  notice?: string
}

/** One call, never throwing: a failed call is an outcome. */
export async function runCall(
  bridge: Pick<AgentBridge, 'timed'>,
  { tool, args }: ParsedLine,
): Promise<CallOutcome> {
  const t0 = performance.now()
  try {
    const { value, ms, appMs, logs, notice } = await bridge.timed(tool, ...args)
    return { tool, ok: true, ms, appMs, value, logs, notice }
  } catch (error) {
    const ms = performance.now() - t0
    const failed = error instanceof AgentBridgeCallError ? error : undefined
    return {
      tool,
      ok: false,
      ms,
      error: error instanceof Error ? error.message : String(error),
      logs: failed?.logs ?? [],
      notice: failed?.notice,
    }
  }
}

/** A line as an outcome: parse errors are failed calls that never left the client. */
export async function runLine(
  bridge: Pick<AgentBridge, 'timed'>,
  line: string,
): Promise<CallOutcome | null> {
  try {
    const parsed = parseBatchLine(line)
    return parsed ? await runCall(bridge, parsed) : null
  } catch (error) {
    if (!(error instanceof BatchParseError)) throw error
    return { tool: error.tool, ok: false, ms: 0, error: error.message, logs: [] }
  }
}

export const MAX_TIME_RUNS = 1000
export const DEFAULT_TIME_RUNS = 10

export type TimeRequest = { call: ParsedLine; runs: number; capped: boolean }

/** `<call> [xN]` for `.time`. N is capped at MAX_TIME_RUNS. */
export function parseTime(rest: string): TimeRequest | null {
  const m = /^(.*?)(?:\s+x(\d+))?$/.exec(rest.trim())
  const call = parseBatchLine(m?.[1] ?? '')
  if (!call) return null
  const wanted = Math.max(1, Number(m?.[2] ?? DEFAULT_TIME_RUNS))
  return { call, runs: Math.min(wanted, MAX_TIME_RUNS), capped: wanted > MAX_TIME_RUNS }
}

export type Spread = { min: number; median: number; max: number }

export function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
  return { min: sorted[0] as number, median, max: sorted.at(-1) as number }
}

const round = (ms: number) => Math.round(ms * 10) / 10

/** A batch input line starting with `.`: the REPL's dot commands, run here as JSON lines. Returns null for `.exit`. */
async function dotLine(
  bridge: Pick<AgentBridge, 'timed' | 'tools'>,
  line: string,
): Promise<Record<string, unknown> | CallOutcome | null> {
  const [name = ''] = line.split(/\s+/)
  const rest = line.slice(name.length).trim()
  switch (name) {
    case '.exit':
      return null
    case '.tools':
      return {
        tool: name,
        ok: true,
        ms: 0,
        value: bridge
          .tools()
          .filter((t) => t.name.startsWith(rest))
          .map((t) => ({ name: t.name, description: t.description })),
      }
    case '.pending':
      return runCall(bridge, { tool: 'bridge.pending', args: [] })
    case '.restore':
      return runCall(bridge, { tool: 'bridge.restore', args: [] })
    case '.time': {
      let request: TimeRequest | null
      try {
        request = parseTime(rest)
      } catch (error) {
        return { tool: name, ok: false, ms: 0, error: (error as Error).message }
      }
      if (!request)
        return { tool: name, ok: false, ms: 0, error: 'Usage: .time <tool> [args] [xN]' }
      const trips: number[] = []
      const inApp: number[] = []
      for (let i = 0; i < request.runs; i++) {
        const outcome = await runCall(bridge, request.call)
        if (!outcome.ok) return outcome
        trips.push(outcome.ms)
        inApp.push(outcome.appMs ?? 0)
      }
      const r = (s: Spread) => ({
        min: round(s.min),
        median: round(s.median),
        max: round(s.max),
      })
      return {
        tool: name,
        ok: true,
        ms: 0,
        value: {
          call: request.call.tool,
          runs: request.runs,
          roundTrip: r(spread(trips)),
          inApp: r(spread(inApp)),
        },
      }
    }
    default:
      return {
        tool: name,
        ok: false,
        ms: 0,
        error: `Unknown command ${name}. In batch mode: .tools, .time, .pending, .restore, .exit`,
      }
  }
}

export type BatchOptions = {
  /** Stop after the first failed call. */
  stopOnError?: boolean
  /** Print results over 32 KB in full. */
  full?: boolean
  /** A new or empty directory: each call's full value goes to `<n>-<tool>.json` in it and the line carries the file summary. */
  outDir?: string
  /** Where lines go. Default stdout. */
  write?: (line: string) => void
}

export type BatchResult = { calls: number; failed: number }

/** Fails early on an --out that would mix this run's files with older ones. */
async function checkOutDir(dir: string) {
  const info = await stat(dir).catch(() => null)
  if (!info) return mkdir(dir, { recursive: true })
  if (!info.isDirectory())
    throw new Error(`--out ${dir} is a file; with --batch it must be a directory`)
  if ((await readdir(dir)).length)
    throw new Error(
      `--out ${dir} is not empty; use a new or empty directory so old files aren't mistaken for this run's`,
    )
}

/** Reads `tool args` lines from `input`; prints one JSON line per call. Lines starting with `.` are the REPL's dot commands. */
export async function runBatch(
  bridge: Pick<AgentBridge, 'timed' | 'tools'>,
  input: NodeJS.ReadableStream,
  options: BatchOptions = {},
): Promise<BatchResult> {
  const write = options.write ?? ((line: string) => console.log(line))
  if (options.outDir) await checkOutDir(options.outDir)
  const result: BatchResult = { calls: 0, failed: 0 }
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  let stopped = false
  try {
    for await (const line of rl) {
      const text = line.trim()
      const outcome = text.startsWith('.')
        ? await dotLine(bridge, text)
        : await runLine(bridge, line)
      if (text.startsWith('.') && outcome === null) break
      if (!outcome) continue
      result.calls++
      const raw = outcome as Record<string, unknown>
      const record: Record<string, unknown> = {
        tool: raw.tool,
        ok: raw.ok,
        ms: round(raw.ms as number),
      }
      if (raw.appMs !== undefined) record.appMs = raw.appMs
      if (raw.ok) {
        try {
          record.value = await shapedResult(raw.value, {
            full: options.full,
            outKind: 'dir',
            out: options.outDir
              ? join(
                  options.outDir,
                  `${result.calls}-${String(raw.tool).replace(/[^\w.-]/g, '_')}.json`,
                )
              : undefined,
          })
        } catch (error) {
          record.ok = false
          record.error = `Could not write the result: ${error instanceof Error ? error.message : error}`
        }
      } else record.error = raw.error
      const logs = raw.logs as LogEntry[] | undefined
      if (logs?.length) record.logs = logs
      if (raw.notice) record.notice = raw.notice
      write(JSON.stringify(record))
      if (!record.ok) {
        result.failed++
        if (options.stopOnError) {
          stopped = true
          break
        }
      }
    }
  } finally {
    rl.close()
    // Don't wait for a producer that keeps stdin open after we stopped.
    if (stopped) (input as { destroy?: () => void }).destroy?.()
  }
  return result
}
