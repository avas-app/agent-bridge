import { connectCdp } from './cdp'
import type { Connection, TransportName } from './connection'
import { metroHost } from './discover'
import { connectExpo } from './expo'

export type OpenOptions = {
  metro?: string
  device?: string
  transport?: 'auto' | TransportName
  /** Give up after this long in total, whatever step is stuck. Default 15 s. */
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

/** A raw connection to one app: Expo's socket first, then CDP, unless forced. */
export async function openConnection(
  options: OpenOptions = {},
): Promise<Connection> {
  const ms = options.timeoutMs ?? OPEN_MS
  const timeout = AbortSignal.timeout(ms)
  const signal = options.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout
  const what = () =>
    timeout.aborted
      ? `Timed out after ${ms} ms opening a connection to Metro`
      : 'Connecting was aborted'
  // Every step below is bounded on its own; this covers a step that isn't,
  // and closes a connection that lands after the abort.
  const attempt = openAttempt(options, signal)
  attempt.then(
    (late) => {
      if (signal.aborted) late.close()
    },
    () => {},
  )
  return abortable(attempt, signal).catch((error) => {
    throw signal.aborted ? new Error(what()) : error
  })
}

async function openAttempt(
  options: OpenOptions,
  signal: AbortSignal,
): Promise<Connection> {
  const metro = metroHost(options.metro)
  const want = options.transport ?? 'auto'
  let expoError: unknown
  if (want !== 'cdp') {
    try {
      return await connectExpo(metro, options.device, undefined, signal)
    } catch (error) {
      if (want === 'expo') throw error
      expoError = error
    }
  }
  try {
    return await connectCdp(metro, options.device, signal)
  } catch (error) {
    const expoNote = expoError ? ` (Expo socket: ${String(expoError)})` : ''
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${expoNote}`,
    )
  }
}
