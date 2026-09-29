// Newline-delimited JSON between the CLI (or connectSession) and a session
// daemon, over a Unix socket or Windows named pipe. One request per line, one
// response per request, matched by id.
import type { DeviceInfo, ResultMessage } from '../../shared/protocol'
import type { TransportName } from '../connection'
import type { SessionState } from './state'

export type SessionRequest = {
  id: number
  op: 'call' | 'tools' | 'info' | 'stop'
  tool?: string
  args?: unknown[]
  timeoutMs?: number
  /** stop: skip bridge.restore and leave the app as it is. */
  keep?: boolean
}

export type SessionResponse = {
  id: number
  /** A daemon-side failure (the app is gone, bad request). Tool errors come in `result`. */
  error?: string
  /** call: the app's ResultMessage, unchanged, so extra fields pass through. */
  result?: ResultMessage
  /** call: round trip from the daemon to the app, in ms. */
  ms?: number
  /** call: the daemon reconnected to the app before answering. */
  reconnected?: boolean
  /** call, stop: the app reloaded, so restores this session held are lost. call has it once; stop has every one. */
  notice?: string
  /** tools, info. */
  device?: DeviceInfo
  transport?: TransportName
  /** info. */
  state?: SessionState
  /** stop: what bridge.restore returned; null with keep. */
  restore?: ResultMessage | null
}

/**
 * One JSON line. readline also breaks lines at U+2028 and U+2029, which
 * JSON.stringify leaves raw, so a result containing one arrived cut in two.
 */
export const encodeLine = (message: unknown): string =>
  `${JSON.stringify(message).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`)}\n`
