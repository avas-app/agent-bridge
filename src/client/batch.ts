// `agent-bridge call --batch`: many calls over one connection, one JSON line each.
import { mkdir } from 'node:fs/promises'
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

/** `tool args` -> the call, or null for a blank line or a `#` comment. */
export function parseBatchLine(line: string): ParsedLine | null {
  const text = line.trim()
  if (!text || text.startsWith('#')) return null
  const at = text.search(/\s/)
  if (at < 0) return { tool: text, args: [] }
  return {
    tool: text.slice(0, at),
    args: parseCallArgs(text.slice(at).trim()),
  }
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

const round = (ms: number) => Math.round(ms * 10) / 10

export type BatchOptions = {
  /** Stop after the first failed call. */
  stopOnError?: boolean
  /** Print results over 32 KB in full. */
  full?: boolean
  /** A directory: each call's full value goes to `<n>-<tool>.json` in it and the line carries the file summary. */
  outDir?: string
  /** Where lines go. Default stdout. */
  write?: (line: string) => void
}

export type BatchResult = { calls: number; failed: number }

/** Reads `tool args` lines from `input`; prints one JSON line per call. */
export async function runBatch(
  bridge: Pick<AgentBridge, 'timed'>,
  input: NodeJS.ReadableStream,
  options: BatchOptions = {},
): Promise<BatchResult> {
  const write = options.write ?? ((line: string) => console.log(line))
  if (options.outDir) await mkdir(options.outDir, { recursive: true })
  const result: BatchResult = { calls: 0, failed: 0 }
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  try {
    for await (const line of rl) {
      const parsed = parseBatchLine(line)
      if (!parsed) continue
      result.calls++
      const outcome = await runCall(bridge, parsed)
      const record: Record<string, unknown> = {
        tool: outcome.tool,
        ok: outcome.ok,
        ms: round(outcome.ms),
      }
      if (outcome.appMs !== undefined) record.appMs = outcome.appMs
      if (outcome.ok)
        record.value = await shapedResult(outcome.value, {
          full: options.full,
          out: options.outDir
            ? join(
                options.outDir,
                `${result.calls}-${outcome.tool.replace(/[^\w.-]/g, '_')}.json`,
              )
            : undefined,
        })
      else record.error = outcome.error
      if (outcome.logs.length) record.logs = outcome.logs
      if (outcome.notice) record.notice = outcome.notice
      write(JSON.stringify(record))
      if (!outcome.ok) {
        result.failed++
        if (options.stopOnError) break
      }
    }
  } finally {
    rl.close()
  }
  return result
}
