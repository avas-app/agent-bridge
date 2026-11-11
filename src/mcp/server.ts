// A stdio MCP server over an AgentBridge: the app's tools as MCP tools.
// Hand-written JSON-RPC (newline-delimited, per the MCP stdio transport) so the
// package stays free of the SDK's dependencies. Nothing but protocol goes to `output`.
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import { type AgentBridge, AgentBridgeCallError, type LogEntry } from '../client/index'
import { logLine } from '../client/log-lines'
import { OUTPUT_LIMIT_BYTES, shapedResult } from '../client/output'
import { encodeLine } from '../client/session/protocol'

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05']

export type McpOptions = {
  input: Readable
  output: Writable
  /** Opens (or reopens) the connection to the app. Called lazily and again after a failure. */
  connect: () => Promise<AgentBridge>
  /** How often to look for a reload or a different app. 0 turns it off. Default 5 s. */
  pollMs?: number
  version?: string
}

export type McpServer = {
  /** Resolves when the input ends. */
  done: Promise<void>
  close: () => void
}

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

type ToolEntry = { name: string; mcp: string; description?: string }

const MAX_NAME = 64

/** MCP names allow letters, digits, `_` and `-`; `screen.snapshot` becomes `screen_snapshot`. Clashes get a number. */
export function mcpNames(tools: Array<{ name: string }>): Map<string, string> {
  const out = new Map<string, string>()
  for (const { name } of tools) {
    const base = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, MAX_NAME - 4) || '_'
    let mcp = base
    for (let n = 2; out.has(mcp); n++) mcp = `${base}_${n}`
    out.set(mcp, name)
  }
  return out
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    args: {
      type: 'array',
      items: {},
      description: "The tool's arguments, in order (each any JSON value). Leave out for none.",
    },
    full: {
      type: 'boolean',
      description: `Return a result over ${OUTPUT_LIMIT_BYTES / 1024} KB whole instead of a summary of its size and shape.`,
    },
  },
  additionalProperties: false,
}

const text = (t: string): Content => ({ type: 'text', text: t })

const logBlock = (logs: LogEntry[]): Content[] =>
  logs.length ? [text(`App errors:\n${logs.map(logLine).join('\n')}`)] : []

/** A screenshot's base64 as an image block, the rest of the value as text. */
function withImage(value: unknown): Content[] | null {
  if (!value || typeof value !== 'object') return null
  const { base64, ...rest } = value as { base64?: unknown }
  if (typeof base64 !== 'string' || !base64) return null
  const data = base64.replace(/^data:[^,]*,/, '')
  const image: Content = { type: 'image', data, mimeType: 'image/png' }
  return Object.keys(rest).length
    ? [image, text(JSON.stringify(rest, null, 2))]
    : [image]
}

async function resultContent(value: unknown, full: boolean): Promise<Content[]> {
  const image = withImage(value)
  if (image) return image
  const shaped = await shapedResult(value, { full })
  const json = JSON.stringify(shaped, null, 2) ?? 'null'
  if (
    !full &&
    shaped &&
    typeof shaped === 'object' &&
    (shaped as { resultTooLarge?: boolean }).resultTooLarge
  )
    return [
      text(
        JSON.stringify(
          {
            ...shaped,
            hint: 'Not returned: the result is large. Call again with full: true to get it whole, or narrow the call (a path, a filter, a smaller page).',
          },
          null,
          2,
        ),
      ),
    ]
  return [text(json)]
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export function startMcpServer(options: McpOptions): McpServer {
  const pollMs = options.pollMs ?? 5000
  let bridge: AgentBridge | null = null
  let opening: Promise<AgentBridge> | null = null
  let tools: ToolEntry[] = []
  let names = new Map<string, string>()
  let signature = ''
  let initialized = false
  let closed = false
  let inflight = 0

  const send = (message: unknown) => {
    if (!closed) options.output.write(encodeLine(message))
  }
  const reply = (id: unknown, result: unknown) =>
    send({ jsonrpc: '2.0', id, result })
  const fail = (id: unknown, code: number, error: string) =>
    send({ jsonrpc: '2.0', id, error: { code, message: error } })

  const adopt = (next: AgentBridge) => {
    const list = next.tools()
    const sig = JSON.stringify([next.device.deviceId, list])
    const changed = sig !== signature
    const first = !signature
    bridge = next
    if (changed) {
      signature = sig
      names = mcpNames(list)
      tools = [...names].map(([mcp, name]) => ({
        name,
        mcp,
        description: list.find((t) => t.name === name)?.description,
      }))
      if (initialized && !first) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }
  }

  const ensure = (): Promise<AgentBridge> => {
    if (bridge) return Promise.resolve(bridge)
    opening ??= options
      .connect()
      .then((next) => {
        adopt(next)
        return next
      })
      .finally(() => {
        opening = null
      })
    return opening
  }

  const drop = () => {
    const old = bridge
    bridge = null
    try {
      old?.close()
    } catch {}
  }

  // Looks again for the app: it may have reloaded, or another one connected.
  let polling = false
  const poll = async () => {
    if (polling || inflight || closed) return
    polling = true
    try {
      if (!bridge) {
        await ensure()
        return
      }
      const next = await options.connect()
      if (inflight || closed) return next.close()
      const old = bridge
      adopt(next)
      if (old !== next) old.close()
    } catch {
      // Nothing to do until the app is back; the next call says why.
    } finally {
      polling = false
    }
  }
  const timer = pollMs > 0 ? setInterval(() => void poll(), pollMs) : undefined
  ;(timer as { unref?: () => void } | undefined)?.unref?.()

  const listTools = () => ({
    tools: tools.map((t) => ({
      name: t.mcp,
      title: t.name,
      description: t.description ?? t.name,
      inputSchema: INPUT_SCHEMA,
    })),
  })

  const callTool = async (params: { name?: unknown; arguments?: unknown }) => {
    const failure = (...content: Content[]) => ({ isError: true, content })
    let b: AgentBridge
    try {
      b = await ensure()
    } catch (error) {
      return failure(
        text(
          `Not connected to the app: ${message(error)}\nStart the app and call again; the server reconnects on the next call.`,
        ),
      )
    }
    const tool = typeof params.name === 'string' ? names.get(params.name) : undefined
    if (!tool) return null
    const input = (params.arguments ?? {}) as { args?: unknown; full?: unknown }
    let args = input.args ?? []
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {}
    }
    if (!Array.isArray(args))
      return failure(text('`args` must be an array of the tool\'s arguments.'))
    inflight++
    try {
      const timed = await b.timed(tool, ...args)
      const content = await resultContent(timed.value, input.full === true)
      content.push(...logBlock(timed.logs))
      if (timed.notice) content.push(text(`Warning: ${timed.notice}`))
      return { content }
    } catch (error) {
      if (error instanceof AgentBridgeCallError)
        return failure(text(error.message), ...logBlock(error.logs))
      // Not a tool error: the connection or the session broke. Reconnect on the next call.
      drop()
      return failure(
        text(
          `${message(error)}\nThe connection to the app was lost. The server reconnects on the next call; if the app reloaded, its pending restores are lost.`,
        ),
      )
    } finally {
      inflight--
    }
  }

  const handle = async (raw: string): Promise<void> => {
    let req: { id?: unknown; method?: unknown; params?: any }
    try {
      req = JSON.parse(raw)
    } catch {
      return void fail(null, -32700, 'Parse error')
    }
    if (!req || typeof req !== 'object' || Array.isArray(req) || typeof req.method !== 'string')
      return void fail(req?.id ?? null, -32600, 'Invalid request')
    const { id, method, params } = req
    const isRequest = id !== undefined
    try {
      switch (method) {
        case 'initialize': {
          const asked = params?.protocolVersion
          reply(id, {
            protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'agent-bridge', version: options.version ?? '0.0.0' },
            instructions:
              "Tools of the connected React Native app. Each takes `args`, an array of the tool's arguments. Results over 32 KB come back as a summary unless `full` is true.",
          })
          // Connect now so the first tools/list already has the app's tools.
          void ensure().catch(() => {})
          return
        }
        case 'notifications/initialized':
          initialized = true
          return
        case 'ping':
          if (isRequest) reply(id, {})
          return
        case 'tools/list':
          // Waits for the connection, but not forever, so a missing app gives an empty list.
          await Promise.race([
            ensure().catch(() => {}),
            new Promise((r) => {
              const t = setTimeout(r, 5000)
              if (typeof t === 'object') t.unref()
            }),
          ])
          return void reply(id, listTools())
        case 'tools/call': {
          const result = await callTool(params ?? {})
          if (result) reply(id, result)
          else fail(id, -32602, `Unknown tool: ${String(params?.name)}`)
          return
        }
        default:
          if (isRequest) fail(id, -32601, `Method not found: ${method}`)
      }
    } catch (error) {
      if (isRequest) fail(id, -32603, message(error))
    }
  }

  const lines = createInterface({ input: options.input })
  const pending = new Set<Promise<void>>()
  lines.on('line', (line) => {
    if (!line.trim()) return
    const p = handle(line).finally(() => pending.delete(p))
    pending.add(p)
  })
  const done = new Promise<void>((resolve) => {
    lines.once('close', () => {
      // Answer what is in flight before the caller ends the process.
      void Promise.allSettled([...pending]).then(() => {
        close()
        resolve()
      })
    })
  })

  function close() {
    if (closed) return
    closed = true
    if (timer) clearInterval(timer)
    lines.close()
    drop()
  }

  return { done, close }
}
