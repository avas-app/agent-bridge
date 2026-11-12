// A stdio MCP server over an AgentBridge: the app's tools as MCP tools.
// Hand-written JSON-RPC (newline-delimited, per the MCP stdio transport) so the
// package stays free of the SDK's dependencies. Nothing but protocol goes to `output`.
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import { type AgentBridge, AgentBridgeCallError, type LogEntry } from '../client/index'
import { logLine } from '../client/log-lines'
import { OUTPUT_LIMIT_BYTES, shapedResult } from '../client/output'
import { SessionLinkError } from '../client/session/client'
import { encodeLine } from '../client/session/protocol'

const SUPPORTED = ['2025-06-18', '2024-11-05']
const STATUS_TOOL = 'agent_bridge_status'

export type McpOptions = {
  input: Readable
  output: Writable
  /** Opens (or reopens) the connection to the app. Called lazily and again after a failure. */
  connect: () => Promise<AgentBridge>
  /** How often to look for a reload or a different app. 0 turns it off. Default 5 s. */
  pollMs?: number
  version?: string
  /** One-off explanation to give instead of running the next call (the session it used stopped). */
  takeNotice?: () => string | undefined
  /** The session in use, for the status tool. */
  sessionName?: () => string | undefined
  /** Notes for the operator (stderr). Connect failures are logged once per distinct message. */
  log?: (line: string) => void
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
export function mcpNames(
  tools: Array<{ name: string }>,
  reserved: string[] = [],
): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Set(reserved)
  // Sorted, so a tool keeps its name whatever order the app lists them in.
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const { name } of sorted) {
    const base = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, MAX_NAME - 4) || '_'
    let mcp = base
    for (let n = 2; taken.has(mcp); n++) mcp = `${base}_${n}`
    taken.add(mcp)
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

const IMAGE_MAGIC: Array<[string, string]> = [
  ['iVBORw0KGgo', 'image/png'],
  ['/9j/', 'image/jpeg'],
  ['UklGR', 'image/webp'],
  ['R0lGOD', 'image/gif'],
]

/** screen.capture's base64 as an image block, the rest of the value as text. Anything that isn't an image stays text. */
function withImage(tool: string, value: unknown): Content[] | null {
  if (tool !== 'screen.capture' || !value || typeof value !== 'object') return null
  const { base64, ...rest } = value as { base64?: unknown }
  if (typeof base64 !== 'string' || !base64) return null
  const url = /^data:([^;,]*)[^,]*,/.exec(base64)
  const data = url ? base64.slice(url[0].length) : base64
  const mimeType = IMAGE_MAGIC.find(([magic]) => data.startsWith(magic))?.[1]
  if (!mimeType) return null
  const image: Content = { type: 'image', data, mimeType }
  return Object.keys(rest).length
    ? [image, text(JSON.stringify(rest, null, 2))]
    : [image]
}

async function resultContent(
  tool: string,
  value: unknown,
  full: boolean,
): Promise<Content[]> {
  const image = withImage(tool, value)
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

type Outcome = { result: unknown } | { code: number; error: string } | null

export function startMcpServer(options: McpOptions): McpServer {
  const pollMs = options.pollMs ?? 5000
  let bridge: AgentBridge | null = null
  let opening: Promise<AgentBridge> | null = null
  let tools: ToolEntry[] = []
  let names = new Map<string, string>()
  let signature = ''
  // The signature of the list last sent to the client, and the last one announced.
  let listed: string | null = null
  let announced = ''
  let initialized = false
  let closed = false
  let inflight = 0
  let lastError: string | undefined

  const send = (message: unknown) => {
    if (!closed) options.output.write(encodeLine(message))
  }
  const reply = (id: unknown, result: unknown) =>
    send({ jsonrpc: '2.0', id, result })
  const fail = (id: unknown, code: number, error: string) =>
    send({ jsonrpc: '2.0', id, error: { code, message: error } })

  const noteError = (error: unknown) => {
    const now = message(error)
    if (now === lastError) return
    lastError = now
    options.log?.(`agent-bridge mcp: not connected: ${now}`)
  }

  // Tell the client when the list it last got is no longer the current one.
  const announce = () => {
    if (!initialized || listed === null || signature === listed || signature === announced)
      return
    announced = signature
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }

  const adopt = (next: AgentBridge) => {
    const list = next.tools()
    const sig = JSON.stringify([next.device.deviceId, list])
    bridge = next
    lastError = undefined
    if (sig !== signature) {
      signature = sig
      names = mcpNames(list, [STATUS_TOOL])
      tools = [...names].map(([mcp, name]) => ({
        name,
        mcp,
        description: list.find((t) => t.name === name)?.description,
      }))
      announce()
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
      .catch((error) => {
        noteError(error)
        throw error
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
    } catch (error) {
      noteError(error)
    } finally {
      polling = false
    }
  }
  const timer = pollMs > 0 ? setInterval(() => void poll(), pollMs) : undefined
  ;(timer as { unref?: () => void } | undefined)?.unref?.()

  const statusTool = {
    name: STATUS_TOOL,
    title: 'agent-bridge status',
    description:
      'Whether this server is connected to the app, which app and session, how many tools it has, and why the last connect failed. Works with no app connected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }

  const listTools = () => {
    listed = signature
    return {
      tools: [
        ...tools.map((t) => ({
          name: t.mcp,
          title: t.name,
          description: t.description ?? t.name,
          inputSchema: INPUT_SCHEMA,
        })),
        statusTool,
      ],
    }
  }

  const statusResult = async () => {
    await ensure().catch(() => {})
    const json = {
      connected: !!bridge,
      ...(bridge && {
        app: { name: bridge.device.name, deviceId: bridge.device.deviceId },
        tools: tools.length,
      }),
      ...(options.sessionName?.() && { session: options.sessionName() }),
      ...(lastError && { lastError }),
    }
    return { content: [text(JSON.stringify(json, null, 2))] }
  }

  const callTool = async (params: { name?: unknown; arguments?: unknown }) => {
    const failure = (...content: Content[]) => ({ isError: true, content })
    if (params.name === STATUS_TOOL) return statusResult()
    const notice = options.takeNotice?.()
    if (notice) {
      drop()
      return failure(text(notice))
    }
    // Counted before the first await so the poll can't swap the connection under this call.
    inflight++
    try {
      let b: AgentBridge
      try {
        b = await ensure()
      } catch (error) {
        return failure(
          text(
            `Not connected to the app: ${message(error)}\nStart the app and call again; the server reconnects on the next call. The ${STATUS_TOOL} tool says what state it is in.`,
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
      try {
        const timed = await b.timed(tool, ...args)
        const content = await resultContent(tool, timed.value, input.full === true)
        content.push(...logBlock(timed.logs))
        if (timed.notice) content.push(text(`Warning: ${timed.notice}`))
        return { content }
      } catch (error) {
        if (error instanceof AgentBridgeCallError)
          return failure(text(error.message), ...logBlock(error.logs))
        if (error instanceof SessionLinkError) {
          // The socket to the session closed mid-call: whether it ran is unknown.
          drop()
          return failure(
            text(
              `${error.message}\nThe call may or may not have run; check before repeating one that changes state. The server reconnects on the next call.`,
            ),
          )
        }
        // A direct connection that stopped answering can't be reused.
        if (/^No reply to "/.test(message(error))) drop()
        return failure(text(message(error)))
      }
    } finally {
      inflight--
    }
  }

  const active = new Map<string, () => void>()

  const dispatch = async (method: string, params: any, id: unknown, isRequest: boolean): Promise<Outcome> => {
    switch (method) {
      case 'initialize': {
        if (!isRequest) return null
        const asked = params?.protocolVersion
        // Connect now so the first tools/list already has the app's tools.
        void ensure().catch(() => {})
        return {
          result: {
            protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'agent-bridge', version: options.version ?? '0.0.0' },
            instructions: `Tools of the connected React Native app. Each takes \`args\`, an array of the tool's arguments. Results over 32 KB come back as a summary unless \`full\` is true. If the list is empty or calls fail, call ${STATUS_TOOL}.`,
          },
        }
      }
      case 'notifications/initialized':
        initialized = true
        return null
      case 'ping':
        return isRequest ? { result: {} } : null
      case 'tools/list':
        if (!isRequest) return null
        // Waits for the connection, but not forever, so a missing app gives a short list.
        await Promise.race([
          ensure().catch(() => {}),
          new Promise((r) => {
            const t = setTimeout(r, 5000)
            if (typeof t === 'object') t.unref()
          }),
        ])
        return { result: listTools() }
      case 'tools/call': {
        if (!isRequest) return null
        const result = await callTool(params ?? {})
        return result
          ? { result }
          : { code: -32602, error: `Unknown tool: ${String(params?.name)}` }
      }
      default:
        return isRequest ? { code: -32601, error: `Method not found: ${method}` } : null
    }
  }

  const handle = async (raw: string): Promise<void> => {
    let req: { id?: unknown; method?: unknown; params?: any }
    try {
      req = JSON.parse(raw)
    } catch {
      return void fail(null, -32700, 'Parse error')
    }
    if (!req || typeof req !== 'object' || Array.isArray(req))
      return void fail(null, -32600, 'Invalid request')
    // A response to something we never asked: nothing to answer.
    if (req.method === undefined && req.id !== undefined) return
    if (typeof req.method !== 'string')
      return void fail(req.id ?? null, -32600, 'Invalid request')
    const { id, method, params } = req
    const isRequest = id !== undefined && id !== null
    if (method === 'notifications/cancelled') {
      active.get(JSON.stringify(params?.requestId))?.()
      return
    }
    const key = JSON.stringify(id)
    let cancel: () => void = () => {}
    const cancelled = new Promise<'cancelled'>((r) => {
      cancel = () => r('cancelled')
    })
    if (isRequest) active.set(key, cancel)
    try {
      const outcome = await Promise.race([dispatch(method, params, id, isRequest), cancelled])
      // A cancelled request gets no reply; its call may still finish in the app.
      if (outcome === 'cancelled' || !outcome) return
      if ('result' in outcome) reply(id, outcome.result)
      else fail(id, outcome.code, outcome.error)
    } catch (error) {
      if (isRequest) fail(id, -32603, message(error))
    } finally {
      if (isRequest) active.delete(key)
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
