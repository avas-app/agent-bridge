import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, rmSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { createInterface } from 'node:readline'

import type { ResultMessage } from '../../shared/protocol'
import type { AppPin, Connection, TransportName } from '../connection'
import { callTimeout } from '../call-timeout'
import { metroHost } from '../discover'
import { explainConnectError } from '../metro-hint'
import { openConnection } from '../open'
import { createJournal } from './journal'
import {
  type SessionRequest,
  type SessionResponse,
  encodeLine,
} from './protocol'
import {
  type SessionState,
  projectRoot,
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
  /** Project the session belongs to. Default: the one at the current directory. */
  project?: string
  device?: string
  transport?: 'auto' | TransportName
  /** Tear down after this long without a call. 0 keeps the session forever. */
  idleMs: number
  /** Per-call timeout when a request doesn't set one. Default 10 s. */
  timeoutMs?: number
  /** How often to ping the app between calls to notice a reload. Default 5 s, 0 off. */
  healthMs?: number
  /** How long calls after app.reload wait for the new bridge. Default 20 s. */
  reloadWaitMs?: number
  /** Longest each transport (Expo, then CDP) may take in one reconnect attempt. Default 12 s. */
  attemptMs?: number
  /** Pause between tries to re-arm the journal after a reload. Default 1 s. */
  adoptRetryMs?: number
}

export type SessionDaemon = {
  state: SessionState
  /** Tears down: bridge.restore unless `keep`, then close and remove the socket. */
  stop: (keep?: boolean) => Promise<ResultMessage | null>
  /** Resolves with the reason ("stop", "idle", a signal) once torn down. */
  done: Promise<string>
}

/** Not run again after a lost reply: it would reload twice. */
const RELOAD = 'app.reload'

/** Read-only tools: running one again after a lost reply changes nothing. */
const REPEATABLE = new Set([
  'bridge.ping',
  'bridge.pending',
  'bridge.tools',
  'screen.snapshot',
  'screen.findText',
  'screen.waitFor',
  'screen.capture',
  'store.get',
  'store.list',
  'query.get',
  'query.list',
  'mmkv.get',
  'mmkv.keys',
  'mmkv.list',
  'net.entry',
  'net.mocks',
  'router.current',
  'scenario.list',
  'webview.list',
  'webview.url',
  'webview.messages',
  'webview.message',
  'webview.snapshot',
  'webview.waitFor',
  'realtime.channels',
])

/** Tools that read a log; `clear: true` empties it, so a second read would come back empty. */
const LOG_TOOLS = new Set(['net.log', 'realtime.log', 'bridge.logs'])

/** Waits that run inside the app; a repeat gets only the time left. */
const WAIT_TOOLS = new Set(['screen.waitFor', 'webview.waitFor'])
const WAIT_DEFAULT_MS = 5000

const repeatable = (tool: string, args: unknown[]) =>
  REPEATABLE.has(tool) ||
  (LOG_TOOLS.has(tool) &&
    !args.some((a) => (a as { clear?: unknown } | null)?.clear))

/** `args` with the wait's options cut to `leftMs`. */
const withTimeLeft = (args: unknown[], leftMs: number): unknown[] => {
  const next = [...args]
  const options = (next[1] as object | null | undefined) ?? {}
  next[1] = { ...options, timeoutMs: Math.max(1, Math.round(leftMs)) }
  return next
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

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
  const reloadWaitMs = options.reloadWaitMs ?? 20_000
  const log = (text: string) =>
    appendFileSync(files.log, `${new Date().toISOString()} ${text}\n`, {
      mode: 0o600,
    })

  const running = readSession(name, dir)
  if (running)
    throw new Error(`Session "${name}" is already running (pid ${running.pid})`)

  const attemptMs = options.attemptMs ?? 12_000
  // Teardown stops reconnect retries at once (`stopping`) and cuts an attempt
  // still in flight after a grace period (`cutOff`); the restore gets one
  // bounded attempt in between.
  const stopping = new AbortController()
  const cutOff = new AbortController()
  const reach = (signal?: AbortSignal, pin?: AppPin) =>
    openConnection({
      metro,
      device: options.device,
      pin,
      transport: options.transport,
      ...(signal && { signal, timeoutMs: attemptMs }),
    })
  const claim = (c: Connection) => {
    const owner = listSessions(dir).find(
      (s) =>
        s.name !== name &&
        s.metro === metro &&
        s.device.deviceId === c.device.deviceId,
    )
    if (!owner) return
    c.close()
    throw new Error(
      `${c.device.name} already belongs to session "${owner.name}". Use --session ${owner.name}, or stop it first.`,
    )
  }
  let conn: Connection = await reach().catch(async (error: unknown) => {
    throw await explainConnectError(error, metro, options.device)
  })
  claim(conn)
  // Reconnects go to this app only: after a reload it has a new deviceId,
  // and anything else connected by then is someone else's app.
  const pin = conn.pin

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
    project: options.project ?? projectRoot(),
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

  // What a reload throws away: the areas that had something to undo, as the
  // app last reported them (every reply carries them) and its bundle load id.
  let knownLoad = conn.device.loadId
  let lastPending: string[] = []
  const reloads: string[] = []
  let unseen: string[] = []
  // Persistent undo state (MMKV, persisted stores) outlives a reload here.
  // The key proves to the runtime that a call is this session's.
  const journalKey = randomBytes(16).toString('hex')
  const send = (tool: string, args: unknown[], ms: number) =>
    conn.call(tool, args, ms, { journalAck: journal.ack(), journalKey })
  const journal = createJournal((tool, args) => send(tool, args, timeoutMs), conn.device.loadId)
  const addNote = (note: string) => {
    reloads.push(note)
    unseen.push(note)
    log(`warning: ${note}`)
  }
  // One adopt at a time; everyone who needs it waits for the one in flight.
  const adoptRetryMs = options.adoptRetryMs ?? 1000
  let adoptRun: Promise<void> | null = null
  let nextAdopt = 0
  const adoptJournal = (force = false): Promise<void> => {
    if (adoptRun) return adoptRun
    if (!journal.hasCarry() || (!force && Date.now() < nextAdopt))
      return Promise.resolve()
    inflight++
    adoptRun = journal
      .adopt()
      .then(
        (note) => {
          if (note) addNote(`app reloaded; ${note}`)
        },
        () => {},
      )
      .finally(() => {
        inflight--
        nextAdopt = Date.now() + adoptRetryMs
        adoptRun = null
      })
    return adoptRun
  }
  const noteReload = (newLoad?: string) => {
    const lost = journal.reloaded(lastPending, newLoad)
    lastPending = []
    if (lost.length || !journal.hasCarry())
      addNote(
        `app reloaded; ${lost.length} pending restore${lost.length === 1 ? '' : 's'} lost${lost.length ? `: ${lost.join(', ')}` : ''}`,
      )
    nextAdopt = 0
    void adoptJournal(true)
  }
  const observe = (r: ResultMessage) => {
    if (!r.loadId) return
    if (knownLoad && r.loadId !== knownLoad) noteReload(r.loadId)
    knownLoad = r.loadId
    lastPending = r.pending ?? []
  }
  // Order matters: a reload seen in the reply moves the journal before its stamp is read.
  const seen = (r: ResultMessage): ResultMessage => {
    observe(r)
    journal.accept(r)
    const { journalData: _, ...rest } = r
    return rest as ResultMessage
  }
  const takeNotice = () => {
    const notice = unseen.join('; ')
    unseen = []
    return notice ? { notice } : {}
  }
  // A reload while app.reload ran: the reply may never come, and the new
  // bridge takes a moment. Calls after it wait for the new load.
  let reloadingUntil = 0

  // Reconnecting is shared, so concurrent calls wait for one re-discovery.
  let stale = false
  let reconnecting: Promise<void> | null = null
  const reconnect = (reason: string) => {
    reconnecting ??= (async () => {
      log(`reconnecting: ${reason}`)
      conn.close()
      const patient = Date.now() < reloadingUntil
      const deadline = Date.now() + (patient ? reloadWaitMs : 0)
      for (;;) {
        try {
          const next = await reach(cutOff.signal, pin)
          claim(next)
          if (patient && knownLoad && next.device.loadId === knownLoad) {
            next.close()
            throw new Error('the old runtime still answers')
          }
          conn = next
          break
        } catch (error) {
          if (stopping.signal.aborted || Date.now() >= deadline) {
            stale = true
            log(`reconnect failed: ${message(error)}`)
            throw new Error(
              patient
                ? `The app is reloading; its bridge isn't ready yet (${message(error)})`
                : `The app is gone (${reason}). Reconnecting failed: ${message(error)}`,
            )
          }
          await pause(300, stopping.signal)
        }
      }
      stale = false
      reloadingUntil = 0
      if (conn.device.loadId) {
        if (knownLoad && conn.device.loadId !== knownLoad) noteReload(conn.device.loadId)
        knownLoad = conn.device.loadId
      }
      state.device = deviceOf(conn)
      state.transport = conn.transport
      save()
      log(`reconnected to ${conn.device.name} via ${conn.transport}`)
    })().finally(() => {
      reconnecting = null
    })
    return reconnecting
  }

  // Calls wait for a reconnect, which is bounded (one attempt: Expo then CDP,
  // each within attemptMs; or the reload window and one more attempt); the
  // race is a backstop so that nothing a reconnect does can hold a call
  // past that.
  const connected = async (reason = 'app stopped answering') => {
    const attempt = reconnecting ?? reconnect(reason)
    const wait =
      Date.now() < reloadingUntil
        ? reloadWaitMs + 2 * attemptMs + 500
        : 2 * attemptMs + 500
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        attempt,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'app not connected; reconnecting. Try again in a moment',
                ),
              ),
            wait,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  const ping = (ms = 1500) =>
    send('bridge.ping', [], Math.min(ms, 1500)).then(
      (r) => {
        if (r.ok) seen(r)
        return r.ok
      },
      () => false,
    )

  // One attempt; `lost` says the connection broke rather than the tool.
  const attempt = async (tool: string, args: unknown[], ms: number) => {
    try {
      const result = await send(tool, args, ms)
      return lostConnection(result) ? { lost: result.error } : { result }
    } catch (error) {
      // A timeout is a slow tool if the app still answers a ping.
      if (await ping(ms)) throw error
      return { lost: message(error) }
    }
  }

  const callApp = async (tool: string, args: unknown[], ms: number) => {
    if (stale || reconnecting) await connected()
    await adoptJournal()
    // A write by another client may not be in the journal yet.
    if (tool === RELOAD) await ping()
    let t0 = performance.now()
    const start = t0
    const first = await attempt(tool, args, ms)
    if (first.result) {
      const result = seen(first.result)
      if (tool === RELOAD && result.ok) waitForReload()
      return { result, ms: performance.now() - t0 }
    }
    if (tool === RELOAD) {
      // The reply was lost with the socket; running it again would reload twice.
      waitForReload()
      const result: ResultMessage = {
        id: '',
        from: '',
        ok: true,
        value: { reloading: true },
        ms: 0,
      }
      return { result, ms: performance.now() - t0 }
    }
    const before = knownLoad
    // A wait for something to go away would pass on a fresh runtime.
    const goneWait =
      WAIT_TOOLS.has(tool) && (args[1] as { gone?: unknown } | null)?.gone
    let reconnectFailure = ''
    try {
      await connected(first.lost)
    } catch (error) {
      reconnectFailure = message(error)
    }
    const reloaded = knownLoad !== before
    // Same app, lost reply: a ping brings the journal of a write that did run.
    if (!reconnectFailure) await sync()
    const again = repeatable(tool, args) && !(goneWait && reloaded)
    // A read-only call has nothing to warn about: the reconnect error says it.
    if (again && reconnectFailure) throw new Error(reconnectFailure)
    if (!again) {
      if ((reloaded || reconnectFailure) && /^(mmkv|store)\./.test(tool))
        addNote(
          `${tool} was cut off; if it wrote to MMKV or a persisted store, that undo may be lost`,
        )
      const how = reloaded
        ? 'the app reloaded'
        : before
          ? 'the app disconnected'
          : 'the connection dropped'
      throw new Error(
        `${how} during ${tool}; it may or may not have run (${first.lost})${
          reconnectFailure ? `; reconnecting failed: ${reconnectFailure}` : ''
        }`,
      )
    }
    t0 = performance.now()
    const retryArgs = WAIT_TOOLS.has(tool)
      ? withTimeLeft(
          args,
          ((args[1] as { timeoutMs?: number } | null)?.timeoutMs ??
            WAIT_DEFAULT_MS) -
            (t0 - start),
        )
      : args
    const second = await attempt(tool, retryArgs, ms)
    if (!second.result)
      throw new Error(
        `The app stopped answering after a reconnect: ${second.lost}`,
      )
    return {
      result: seen(second.result),
      ms: performance.now() - t0,
      reconnected: true,
    }
  }
  const sync = async () => {
    if (journal.hasCarry()) await adoptJournal(true)
    else await ping()
  }
  const waitForReload = () => {
    reloadingUntil = Date.now() + reloadWaitMs
    stale = true
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
          const pinged = conn
          const answered = await ping()
          // A call that started during the ping owns the connection now.
          if (inflight || reconnecting || finishing || conn !== pinged) return
          if (stale || !answered)
            await reconnect('no answer to bridge.ping').catch(() => {})
        }, options.healthMs ?? 5000)
  // The ping alone mustn't keep the process alive (Node timers have unref).
  const timer = health as { unref?: () => void } | undefined
  timer?.unref?.()

  // Not callApp: #83 never repeats bridge.restore after a lost reply, but a stop must
  // not leave fakes behind, so it re-checks what is pending and restores once more only if needed.
  const restoreOnce = async (): Promise<ResultMessage> => {
    const fail = (error: string): ResultMessage => ({ id: 'restore', from: '', ok: false, error, ms: 0 })
    const run = (tool: string) => attempt(tool, [], timeoutMs)
    try {
      // A quick ping tells a dead connection apart from a slow restore.
      if (stale || reconnecting || !(await ping())) await connected('no answer before restore')
      await adoptJournal(true)
      const first = await run('bridge.restore')
      if (first.result) return seen(first.result)
      await connected(first.lost)
      await adoptJournal(true)
      const check = await run('bridge.pending')
      if (!check.result) return fail(`restore may or may not have run (${first.lost})`)
      const left = seen(check.result)
      if (!left.ok) return fail(`restore may or may not have run (${first.lost}); ${left.error}`)
      if (!Object.keys(left.value as object).length)
        return { ...left, id: 'restore', value: { note: 'the reply was lost; nothing is pending now' } }
      const second = await run('bridge.restore')
      return second.result
        ? seen(second.result)
        : fail(`The app stopped answering after a reconnect: ${second.lost}`)
    } catch (error) {
      return fail(message(error))
    }
  }

  let finishing: Promise<ResultMessage | null> | null = null
  let resolveDone: (reason: string) => void = () => {}
  const done = new Promise<string>((r) => {
    resolveDone = r
  })
  const teardown = (reason: string, keep: boolean) => {
    finishing ??= (async () => {
      clearTimeout(idleTimer)
      clearInterval(health)
      // No more retries, and an attempt in flight is cut off after a grace
      // period; the restore below still gets that one attempt if the app
      // is back.
      stopping.abort()
      const cut = setTimeout(() => cutOff.abort(), Math.min(attemptMs, 5000))
      let restore: ResultMessage | null = null
      if (!keep) {
        restore = await restoreOnce()
        const left = journal.giveUp()
        if (left) addNote(`app reloaded; ${left}`)
      }
      clearTimeout(cut)
      cutOff.abort()
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

  // bridge.pending, or undefined from an app without it (or one that can't answer).
  const readPending = async () => {
    try {
      const { result } = await callApp('bridge.pending', [], timeoutMs)
      return result.ok ? (result.value as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }

  const handle = async (req: SessionRequest): Promise<SessionResponse> => {
    if (finishing && req.op !== 'stop')
      return { id: req.id, error: `Session "${name}" is stopping` }
    switch (req.op) {
      case 'call': {
        if (!req.tool) return { id: req.id, error: 'call needs a tool' }
        if (req.tool === 'bridge.adopt')
          return { id: req.id, error: 'bridge.adopt is for a session\'s own use' }
        inflight++
        touch()
        try {
          const args = req.args ?? []
          const answer = await callApp(
            req.tool,
            args,
            callTimeout(req.timeoutMs ?? timeoutMs, req.tool, args),
          )
          await adoptRun
          return { id: req.id, ...answer, ...takeNotice() }
        } catch (error) {
          // The reload is often why the call failed; don't lose the notice.
          await adoptRun
          return { id: req.id, error: message(error), ...takeNotice() }
        } finally {
          inflight--
          touch()
        }
      }
      case 'tools':
        touch()
        if (stale || reconnecting) await connected()
        return { id: req.id, device: conn.device, transport: conn.transport }
      case 'info':
        return {
          id: req.id,
          state,
          device: conn.device,
          transport: conn.transport,
        }
      case 'stop': {
        if (req.dryRun && finishing)
          return { id: req.id, error: `Session "${name}" is stopping` }
        // A dry run, or a stop that leaves the app as it is: say what a
        // restore would put back.
        const pending = req.dryRun || req.keep ? await readPending() : undefined
        if (req.dryRun) return { id: req.id, pending }
        return {
          id: req.id,
          restore: await teardown('stop', !!req.keep),
          ...(pending && { pending }),
          ...(reloads.length && { notice: reloads.join('; ') }),
        }
      }
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
      if (!socket.writableEnded) socket.write(encodeLine(res))
      if (req.op === 'stop' && !req.dryRun) closeClients()
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
  await ping()
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
