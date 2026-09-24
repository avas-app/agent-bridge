import type { LogEntry } from '../shared/protocol'

const CAPACITY = 200
const STACK_LINES = 10
const MESSAGE_CHARS = 2000

type Level = LogEntry['level']

export type LogCapture = {
  record: (level: Level, args: unknown[]) => void
  /** Marks a tool call as running; call the result when it finishes. */
  begin: (tool: string) => () => void
  /** Errors recorded since the last time this was called. */
  takeErrors: () => LogEntry[]
  read: (options?: { level?: Level | 'all'; limit?: number }) => LogEntry[]
  clear: () => void
}

/** A ring buffer of entries, each tagged with the tool call it happened in or after. */
export function createLogCapture(now: () => number = Date.now): LogCapture {
  const buffer: Array<{ seq: number; entry: LogEntry }> = []
  const running: string[] = []
  let seq = 0
  let sent = 0
  let lastTool: string | undefined

  return {
    record(level, args) {
      const entry: LogEntry = { level, ...formatArgs(args), at: now() }
      const during = running[running.length - 1]
      if (during) entry.during = during
      else if (lastTool) entry.after = lastTool
      buffer.push({ seq: ++seq, entry })
      if (buffer.length > CAPACITY) buffer.shift()
    },
    begin(tool) {
      running.push(tool)
      let done = false
      return () => {
        if (done) return
        done = true
        running.splice(running.lastIndexOf(tool), 1)
        lastTool = tool
      }
    },
    takeErrors() {
      const since = sent
      sent = seq
      return buffer
        .filter((b) => b.seq > since && b.entry.level === 'error')
        .map((b) => b.entry)
    },
    read({ level = 'all', limit } = {}) {
      const entries = buffer
        .map((b) => b.entry)
        .filter((e) => level === 'all' || e.level === level)
      return limit !== undefined ? entries.slice(-limit) : entries
    },
    clear() {
      buffer.length = 0
    },
  }
}

/** console-style args to a message, applying %s-style substitutions. */
export function formatArgs(args: unknown[]): {
  message: string
  stack?: string
} {
  const rest = [...args]
  const parts: string[] = []
  if (typeof rest[0] === 'string' && rest[0].includes('%')) {
    const format = rest.shift() as string
    parts.push(
      format.replace(/%([sdifoOc%])/g, (match, type: string) => {
        if (type === '%') return '%'
        if (!rest.length) return match
        const arg = rest.shift()
        if (type === 'c') return ''
        if (type === 'd' || type === 'i') return String(Math.trunc(Number(arg)))
        if (type === 'f') return String(Number(arg))
        return describe(arg)
      }),
    )
  }
  parts.push(...rest.map(describe))
  const error = args.find((a): a is Error => a instanceof Error)
  const message = parts.join(' ')
  return {
    message:
      message.length > MESSAGE_CHARS
        ? `${message.slice(0, MESSAGE_CHARS)}...`
        : message,
    ...(error?.stack ? { stack: trimStack(error.stack) } : {}),
  }
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (value === undefined || typeof value === 'function') return String(value)
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return String(value)
    return json.length > 200 ? `${json.slice(0, 200)}...` : json
  } catch {
    return String(value)
  }
}

const trimStack = (stack: string) =>
  stack.split('\n').slice(0, STACK_LINES).join('\n')

type ErrorHandler = (error: unknown, isFatal?: boolean) => void

/** The globals capture hooks into; a parameter so tests can pass fakes. */
export type LogEnv = {
  console: Pick<Console, 'error' | 'warn'>
  ErrorUtils?: {
    getGlobalHandler: () => ErrorHandler
    setGlobalHandler: (handler: ErrorHandler) => void
  }
  addEventListener?: (type: string, listener: (event: never) => void) => void
  removeEventListener?: (
    type: string,
    listener: (event: never) => void,
  ) => void
}

/**
 * Wraps console.error/warn, React Native's global error handler, and on web the
 * window's error and unhandledrejection events. Each hook records, then calls
 * through. Returns a function that puts back whatever is still ours.
 *
 * Unhandled promise rejections on React Native reach console.error through
 * ExceptionsManager. Hermes' rejection tracker can't be chained (no getter),
 * so replacing it would drop React Native's own reporting.
 */
export function installLogHooks(capture: LogCapture, env: LogEnv): () => void {
  // Anything logged while recording, or while React Native's handler runs,
  // is either ours or the same error again.
  let quiet = 0
  let active = true
  const record = (level: Level, args: unknown[]) => {
    if (!active || quiet) return
    quiet++
    try {
      capture.record(level, args)
    } catch {
      // Never let logging break the app.
    } finally {
      quiet--
    }
  }

  const { console } = env
  const originals = { error: console.error, warn: console.warn }
  const wrappers = {
    error: (...args: unknown[]) => {
      record('error', args)
      originals.error.apply(console, args)
    },
    warn: (...args: unknown[]) => {
      record('warn', args)
      originals.warn.apply(console, args)
    },
  }
  console.error = wrappers.error
  console.warn = wrappers.warn

  const errorUtils = env.ErrorUtils
  const originalHandler = errorUtils?.getGlobalHandler()
  const handler: ErrorHandler = (error, isFatal) => {
    record('error', [error])
    quiet++
    try {
      originalHandler?.(error, isFatal)
    } finally {
      quiet--
    }
  }
  if (errorUtils) errorUtils.setGlobalHandler(handler)

  const onError = (event: { error?: unknown; message?: string }) =>
    record('error', [event.error ?? event.message])
  const onRejection = (event: { reason?: unknown }) =>
    record('error', ['Unhandled promise rejection:', event.reason])
  const listens =
    typeof env.addEventListener === 'function' &&
    typeof env.removeEventListener === 'function'
  if (listens) {
    env.addEventListener?.('error', onError)
    env.addEventListener?.('unhandledrejection', onRejection)
  }

  return () => {
    active = false
    // Someone may have wrapped on top of us; then ours stays, inert.
    if (console.error === wrappers.error) console.error = originals.error
    if (console.warn === wrappers.warn) console.warn = originals.warn
    if (
      errorUtils &&
      originalHandler &&
      errorUtils.getGlobalHandler() === handler
    )
      errorUtils.setGlobalHandler(originalHandler)
    if (listens) {
      env.removeEventListener?.('error', onError)
      env.removeEventListener?.('unhandledrejection', onRejection)
    }
  }
}

const STATE = Symbol.for('@avasapp/agent-bridge/logs')

type State = { capture: LogCapture; users: number; uninstall?: () => void }

/**
 * Starts capture for one bridge. Bridges share one capture and one set of
 * hooks, kept on the global so a restart or a second copy of this module never
 * wraps twice. Hooks come off when the last bridge stops; the buffer stays.
 */
export function startLogCapture(env: LogEnv = globalThis as unknown as LogEnv): {
  capture: LogCapture
  stop: () => void
} {
  const holder = env as unknown as Record<symbol, State | undefined>
  const state = (holder[STATE] ??= { capture: createLogCapture(), users: 0 })
  if (state.users++ === 0) state.uninstall = installLogHooks(state.capture, env)
  let stopped = false
  return {
    capture: state.capture,
    stop() {
      if (stopped) return
      stopped = true
      if (--state.users === 0) {
        state.uninstall?.()
        state.uninstall = undefined
      }
    },
  }
}
