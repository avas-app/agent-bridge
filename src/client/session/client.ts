import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'

import type { TransportName } from '../connection'
import { metroHost } from '../discover'
import { type AgentBridge, AgentBridgeCallError, type Timed } from '../index'
import type { SessionRequest, SessionResponse } from './protocol'
import { type SessionState, pickSession } from './state'

type Link = {
  request: (req: Omit<SessionRequest, 'id'>) => Promise<SessionResponse>
  close: () => void
}

/** Opens a session's socket. Requests are matched to responses by id. */
export function openSessionLink(state: SessionState): Promise<Link> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(state.socket)
    const waiting = new Map<number, (res: SessionResponse) => void>()
    let seq = 0
    let open = false
    const gone = `Session "${state.name}" closed the connection`
    socket.once('connect', () => {
      open = true
      resolve({
        request: (req) =>
          new Promise((done, fail) => {
            if (socket.destroyed || socket.writableEnded) {
              fail(new Error(gone))
              return
            }
            const id = ++seq
            waiting.set(id, done)
            socket.write(`${JSON.stringify({ ...req, id })}\n`)
          }),
        close: () => socket.end(),
      })
    })
    socket.on('error', (error) => {
      if (!open)
        reject(
          new Error(
            `Session "${state.name}" isn't answering on ${state.socket}: ${error.message}`,
          ),
        )
    })
    socket.on('close', () => {
      for (const [id, done] of waiting) done({ id, error: gone })
      waiting.clear()
    })
    createInterface({ input: socket }).on('line', (line) => {
      const res = JSON.parse(line) as SessionResponse
      waiting.get(res.id)?.(res)
      waiting.delete(res.id)
    })
  })
}

export async function sessionRequest(
  state: SessionState,
  req: Omit<SessionRequest, 'id'>,
): Promise<SessionResponse> {
  const link = await openSessionLink(state)
  try {
    return await link.request(req)
  } finally {
    link.close()
  }
}

export type SessionConnectOptions = {
  /** Session name. Defaults to $AGENT_BRIDGE_SESSION, else the only session on this Metro. */
  name?: string
  metro?: string
  device?: string
  transport?: 'auto' | TransportName
  /** Per-call timeout. Default: the session's (10 s). */
  timeoutMs?: number
}

/**
 * Like `connect()`, through a running session (`agent-bridge session start`):
 * no discovery, and the app stays connected when this closes.
 */
export async function connectSession(
  options: SessionConnectOptions = {},
): Promise<AgentBridge & { session: SessionState }> {
  const state = pickSession({
    name: options.name ?? process.env.AGENT_BRIDGE_SESSION,
    metro: metroHost(options.metro),
    device: options.device,
    transport: options.transport,
  })
  if (!state)
    throw new Error(
      'No single session matches. Start one with `agent-bridge session start`, or name it.',
    )
  const link = await openSessionLink(state)
  const info = await link.request({ op: 'info' })
  if (info.error || !info.device || !info.transport) {
    link.close()
    throw new Error(info.error ?? `Session "${state.name}" sent no device`)
  }
  const device = info.device

  const timed = async <T>(
    tool: string,
    ...args: unknown[]
  ): Promise<Timed<T>> => {
    const res = await link.request({
      op: 'call',
      tool,
      args,
      timeoutMs: options.timeoutMs,
    })
    if (res.error || !res.result) throw new Error(res.error ?? 'No result')
    const result = res.result
    if (!result.ok) throw new AgentBridgeCallError(tool, result.error)
    // Extra fields on the result (such as logs) pass through as they are.
    const { id: _id, from: _from, ok: _ok, ms: appMs, value, ...extra } = result
    return { ...extra, value: value as T, ms: res.ms ?? 0, appMs }
  }

  return {
    session: info.state ?? state,
    transport: info.transport,
    device,
    timed,
    call: async <T>(tool: string, ...args: unknown[]) =>
      (await timed<T>(tool, ...args)).value,
    tools: () => device.tools,
    close: link.close,
  }
}
