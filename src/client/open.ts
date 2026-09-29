import { connectCdp } from './cdp'
import { type Connection, OpenGaveUp, type TransportName } from './connection'
import { metroHost } from './discover'
import { connectExpo } from './expo'

export type OpenOptions = {
  metro?: string
  device?: string
  transport?: 'auto' | TransportName
  /**
   * Give up on each transport (Expo's socket, then CDP) after this long,
   * whatever step is stuck. Budgeted separately so a slow Expo upgrade
   * doesn't leave CDP no time. Default 15 s.
   */
  timeoutMs?: number
  /** Abort the attempt, closing any socket it opened. */
  signal?: AbortSignal
}

const OPEN_MS = 15_000

/** Rejects when `signal` aborts, whatever `work` is doing. */
const abortable = <T>(work: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })

/**
 * One transport's attempt within its own budget. Every step inside is bounded
 * on its own; this covers a step that isn't, and closes a connection that
 * lands after the deadline or abort.
 */
function phase(
  options: OpenOptions,
  run: (signal: AbortSignal) => Promise<Connection>,
): Promise<Connection> {
  const ms = options.timeoutMs ?? OPEN_MS
  const timeout = AbortSignal.timeout(ms)
  const signal = options.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout
  const attempt = run(signal)
  attempt.then(
    (late) => {
      if (signal.aborted) late.close()
    },
    () => {},
  )
  return abortable(attempt, signal).catch((error) => {
    if (!signal.aborted) throw error
    throw new OpenGaveUp(
      timeout.aborted
        ? `Timed out after ${ms} ms opening a connection to Metro`
        : 'Connecting was aborted',
    )
  })
}

/** A raw connection to one app: Expo's socket first, then CDP, unless forced. */
export async function openConnection(
  options: OpenOptions = {},
): Promise<Connection> {
  const metro = metroHost(options.metro)
  const want = options.transport ?? 'auto'
  let expoError: unknown
  if (want !== 'cdp') {
    try {
      return await phase(options, (signal) =>
        connectExpo(metro, options.device, undefined, signal),
      )
    } catch (error) {
      if (want === 'expo' || options.signal?.aborted) throw error
      expoError = error
    }
  }
  try {
    return await phase(options, (signal) =>
      connectCdp(metro, options.device, signal),
    )
  } catch (error) {
    const expoNote = expoError ? ` (Expo socket: ${String(expoError)})` : ''
    const text = `${error instanceof Error ? error.message : String(error)}${expoNote}`
    throw error instanceof OpenGaveUp ? new OpenGaveUp(text) : new Error(text)
  }
}
