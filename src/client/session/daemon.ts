import { appendFileSync, chmodSync, rmSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { createInterface } from 'node:readline'

import type { ResultMessage } from '../../shared/protocol'
import type { Connection, TransportName } from '../connection'
import { metroHost } from '../discover'
import { openConnection } from '../open'
import type { SessionRequest, SessionResponse } from './protocol'
import {
  type SessionState,
  checkName,
  listSessions,
  readSession,
  removeSessionFiles,
  sessionFiles,
  stateDir,
  writePrivate,
} from './state'

export type DaemonOptions = {
  name: string
  metro?: string
  device?: string
  transport?: 'auto' | TransportName
  /** Tear down after this long without a call. 0 keeps the session forever. */
  idleMs: number
  /** Per-call timeout when a request doesn't set one. Default 10 s. */
  timeoutMs?: number
  /** How often to ping the app between calls to notice a reload. Default 5 s, 0 off. */
  healthMs?: number
}

export type SessionDaemon = {
  state: SessionState
  /** Tears down: bridge.restore unless `keep`, then close and remove the socket. */
  stop: (keep?: boolean) => Promise<ResultMessage | null>
  /** Resolves with the reason ("stop", "idle", a signal) once torn down. */
  done: Promise<string>
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** A failed result that means the connection, not the tool, broke. */
const lostConnection = (
  r: ResultMessage,
): r is Extract<ResultMessage, { ok: false }> =>
  !r.ok &&
  (r.from === '' || /socket closed|closed the debugger|not open/i.test(r.error))

/**
 * Connects to one app and serves calls on a local socket until stopped or
 * idle. Throws the connect error if the app can't be reached, or if another
 * live session already drives this app.
 */
export async function runSessionDaemon(
  options: DaemonOptions,
): Promise<SessionDaemon> {
  const name = checkName(options.name)
  const dir = stateDir()
  const files = sessionFiles(name, dir)
  const metro = metroHost(options.metro)
  const timeoutMs = options.timeoutMs ?? 10_000
  const log = (text: string) =>
    appendFileSync(files.log, `${new Date().toISOString()} ${text}\n`, {
      mode: 0o600,
    })

  const running = readSession(name, dir)
  if (running)
    throw new Error(`Session "${name}" is already running (pid ${running.pid})`)

  const reach = () =>
    openConnection({
      metro,
      device: options.device,
      transport: options.transport,
    })
  let conn: Connection = await reach()
  const owner = listSessions(dir).find(
    (s) => s.metro === metro && s.device.deviceId === conn.device.deviceId,
  )
  if (owner) {
    conn.close()
    throw new Error(
      `${conn.device.name} already belongs to session "${owner.name}". Use --session ${owner.name}, or stop it first.`,
    )
  }

  const deviceOf = (c: Connection) => ({
    name: c.device.name,
    deviceId: c.device.deviceId,
    platform: c.device.platform,
  })
  const state: SessionState = {
    name,
    pid: process.pid,
    socket: files.socket,
    metro,
    device: deviceOf(conn),
    deviceFilter: options.device,
    transport: conn.transport,
    startedAt: Date.now(),
    lastCallAt: Date.now(),
    idleMs: options.idleMs,
  }
  // Never after teardown began: the state file must not outlive the session.
  const save = () => {
    if (!finishing) writePrivate(files.state, JSON.stringify(state, null, 2))
  }

  // Reconnecting is shared, so concurrent calls wait for one re-discovery.
  let stale = false
  let reconnecting: Promise<void> | null = null
  const reconnect = (reason: string) => {
    reconnecting ??= (async () => {
      log(`reconnecting: ${reason}`)
      conn.close()
      try {
        conn = await reach()
      } catch (error) {
        stale = true
        log(`reconnect failed: ${message(error)}`)
        throw new Error(
          `The app is gone (${reason}). Reconnecting failed: ${message(error)}`,
        )
      }
      stale = false
      state.device = deviceOf(conn)
      state.transport = conn.transport
      save()
      log(`reconnected to ${conn.device.name} via ${conn.transport}`)
    })().finally(() => {
      reconnecting = null
    })
    return reconnecting
  }

  const ping = (ms = 1500) =>
    conn.call('bridge.ping', [], Math.min(ms, 1500)).then(
      (r) => r.ok,
      () => false,
    )

  // One attempt; `lost` says the connection broke rather than the tool.
  const attempt = async (tool: string, args: unknown[], ms: number) => {
    try {
      const result = await conn.call(tool, args, ms)
      return lostConnection(result) ? { lost: result.error } : { result }
    } catch (error) {
      // A timeout is a slow tool if the app still answers a ping.
      if (await ping(ms)) throw error
      return { lost: message(error) }
    }
  }

  const callApp = async (tool: string, args: unknown[], ms: number) => {
    if (stale || reconnecting)
      await (reconnecting ?? reconnect('app stopped answering'))
    let t0 = performance.now()
    const first = await attempt(tool, args, ms)
    if (first.result)
      return { result: first.result, ms: performance.now() - t0 }
    await reconnect(first.lost)
    t0 = performance.now()
    const second = await attempt(tool, args, ms)
    if (!second.result)
      throw new Error(
        `The app stopped answering after a reconnect: ${second.lost}`,
      )
    return {
      result: second.result,
      ms: performance.now() - t0,
      reconnected: true,
    }
  }

  let inflight = 0
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armIdle = () => {
    clearTimeout(idleTimer)
    if (!options.idleMs) return
    idleTimer = setTimeout(() => {
      if (inflight) armIdle()
      else void teardown('idle', false).then(closeClients)
    }, options.idleMs)
  }
  const touch = () => {
    if (finishing) return
    state.lastCallAt = Date.now()
    save()
    armIdle()
  }

  const health =
    options.healthMs === 0
      ? undefined
      : setInterval(async () => {
          if (inflight || reconnecting || finishing) return
          if (stale || !(await ping()))
            await reconnect('no answer to bridge.ping').catch(() => {})
        }, options.healthMs ?? 5000)
  // The ping alone mustn't keep the process alive (Node timers have unref).
  const timer = health as { unref?: () => void } | undefined
  timer?.unref?.()

  let finishing: Promise<ResultMessage | null> | null = null
  let resolveDone: (reason: string) => void = () => {}
  const done = new Promise<string>((r) => {
    resolveDone = r
  })
  const teardown = (reason: string, keep: boolean) => {
    finishing ??= (async () => {
      clearTimeout(idleTimer)
      clearInterval(health)
      let restore: ResultMessage | null = null
      if (!keep) {
        restore = await callApp('bridge.restore', [], timeoutMs).then(
          (r) => r.result,
          (error): ResultMessage => ({
            id: 'restore',
            from: '',
            ok: false,
            error: message(error),
            ms: 0,
          }),
        )
      }
      conn.close()
      server.close()
      removeSessionFiles(name, dir)
      const outcome = !restore
        ? 'kept app state'
        : restore.ok
          ? `restore: ${JSON.stringify(restore.value)}`
          : `restore: ${restore.error}`
      log(`stopped (${reason}); ${outcome}`)
      // Done once the clients have their answers (or after 2 s regardless).
      const deadline = Date.now() + 2000
      const settle = () => {
        if (!clients.size || Date.now() > deadline) resolveDone(reason)
        else setTimeout(settle, 10)
      }
      settle()
      return restore
    })()
    return finishing
  }

  const handle = async (req: SessionRequest): Promise<SessionResponse> => {
    if (finishing && req.op !== 'stop')
      return { id: req.id, error: `Session "${name}" is stopping` }
    switch (req.op) {
      case 'call': {
        if (!req.tool) return { id: req.id, error: 'call needs a tool' }
        inflight++
        touch()
        try {
          return {
            id: req.id,
            ...(await callApp(
              req.tool,
              req.args ?? [],
              req.timeoutMs ?? timeoutMs,
            )),
          }
        } finally {
          inflight--
          touch()
        }
      }
      case 'tools':
        touch()
        if (stale || reconnecting)
          await (reconnecting ?? reconnect('app stopped answering'))
        return { id: req.id, device: conn.device, transport: conn.transport }
      case 'info':
        return {
          id: req.id,
          state,
          device: conn.device,
          transport: conn.transport,
        }
      case 'stop':
        return { id: req.id, restore: await teardown('stop', !!req.keep) }
      default:
        return { id: req.id, error: `Unknown op "${String(req.op)}"` }
    }
  }

  const clients = new Set<Socket>()
  const closeClients = () => {
    for (const socket of clients) socket.end()
  }
  const server: Server = createServer((socket) => {
    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => {})
    createInterface({ input: socket }).on('line', async (line) => {
      let req: SessionRequest
      try {
        req = JSON.parse(line) as SessionRequest
      } catch {
        return
      }
      const res = await handle(req).catch((error): SessionResponse => ({
        id: req.id,
        error: message(error),
      }))
      if (!socket.writableEnded) socket.write(`${JSON.stringify(res)}\n`)
      if (req.op === 'stop') closeClients()
    })
  })

  if (process.platform !== 'win32') rmSync(files.socket, { force: true })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(files.socket, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    conn.close()
    clearInterval(health)
    throw error
  }
  if (process.platform !== 'win32') chmodSync(files.socket, 0o600)
  touch()
  log(
    `started: ${conn.device.name} via ${conn.transport} on ${metro}, pid ${process.pid}, idle ${options.idleMs} ms`,
  )

  return {
    state,
    stop: async (keep = false) => {
      const restore = await teardown('stop', keep)
      closeClients()
      return restore
    },
    done,
  }
}
