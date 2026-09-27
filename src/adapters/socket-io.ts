import { createRealtimeTap, type RealtimeConnection, type RealtimeTap } from '../realtime/tap'
import type { Tools } from '../runtime/types'

// oxlint-disable-next-line no-explicit-any -- socket.io listeners take any arguments
type Listener = (...args: any[]) => void

/** A socket.io client socket (`io(url)`), typed structurally. */
export type SocketLike = {
  on(event: string, listener: Listener): unknown
  off(event?: string, listener?: Listener): unknown
  connected?: boolean
}

export type SocketIoToolsOptions = {
  /** Tool name prefix. Defaults to "realtime". */
  namespace?: string
}

type Tracked = {
  event: string
  original: Listener & { fn?: Listener }
  wrapped: Listener
  unsubscribe: () => void
}

// Lifecycle events, not messages. Faked through realtime.connection instead.
const RESERVED = new Set([
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener',
])

const taps = new WeakMap<object, RealtimeTap<unknown[]>>()

// Fakes `connect` / `disconnect` and `socket.connected`. Needs the socket's
// `emitReserved`, which socket.io-client uses for lifecycle events.
function fakeableConnection(socket: SocketLike): RealtimeConnection | undefined {
  const target = socket as SocketLike & {
    emitReserved?: (...args: unknown[]) => unknown
  }
  const emitReserved = target.emitReserved
  if (typeof emitReserved !== 'function') return undefined
  let real = Boolean(socket.connected)
  let fake: boolean | null = null
  Object.defineProperty(socket, 'connected', {
    configurable: true,
    enumerable: true,
    get: () => fake ?? real,
    set: (value: boolean) => {
      real = value
    },
  })
  // While a state is faked, the app hears nothing about the real one.
  target.emitReserved = function (this: unknown, ...args: unknown[]) {
    return fake === null ? emitReserved.apply(this, args) : undefined
  }
  const name = (connected: boolean) => (connected ? 'connected' : 'disconnected')
  return {
    state: () => name(real),
    states: ['connected', 'disconnected'],
    fake: (state, previous) => {
      fake = state === null ? null : state === 'connected'
      const current = state ?? name(real)
      if (current === previous) return
      if (current === 'connected') emitReserved.call(socket, 'connect')
      else emitReserved.call(socket, 'disconnect', 'transport close')
    },
  }
}

function install(
  socket: SocketLike,
  options: SocketIoToolsOptions,
): RealtimeTap<unknown[]> {
  const tap = createRealtimeTap<unknown[]>({
    namespace: options.namespace,
    // The last argument is an ack callback when the server asked for one.
    describe: (args) => {
      const values = args.filter((a) => typeof a !== 'function')
      return { data: values.length === 1 ? values[0] : values }
    },
    toMessage: (values) => values,
    connection: fakeableConnection(socket),
  })
  const tracked: Tracked[] = []
  const target = socket as unknown as Record<string, Listener | undefined>
  const on = socket.on as Listener
  const off = socket.off as Listener

  function patchedOn(this: unknown, event: string, original: Listener) {
    if (
      typeof event !== 'string' ||
      typeof original !== 'function' ||
      RESERVED.has(event)
    )
      return on.call(this, event, original)
    const { listener, unsubscribe } = tap.wrap(event, (args) =>
      original.apply(socket, args),
    )
    const wrapped: Listener = (...args) => listener(args)
    tracked.push({ event, original, wrapped, unsubscribe })
    return on.call(this, event, wrapped)
  }

  // off(), off(event), off(event, listener). `once` goes through on/off, and
  // marks its wrapper with `.fn`, so off(event, fn) finds a once listener too.
  function patchedOff(this: unknown, event?: string, listener?: Listener) {
    const hits = tracked.filter(
      (t) =>
        (event === undefined || t.event === event) &&
        (!listener || t.original === listener || t.original.fn === listener),
    )
    for (const hit of hits) {
      tracked.splice(tracked.indexOf(hit), 1)
      hit.unsubscribe()
    }
    if (!listener || !hits.length)
      return off.apply(this, event === undefined ? [] : listener ? [event, listener] : [event])
    for (const hit of hits) off.call(this, hit.event, hit.wrapped)
    return this
  }

  for (const name of ['on', 'addEventListener'])
    if (typeof target[name] === 'function') target[name] = patchedOn as Listener
  for (const name of ['off', 'removeListener', 'removeAllListeners', 'removeEventListener'])
    if (typeof target[name] === 'function') target[name] = patchedOff as Listener
  return tap
}

/**
 * See, fake and drop socket.io events: `realtime.*`, where a channel is an
 * event name. Patches the socket, so call it where you create the socket,
 * before the app adds listeners. Calling it again with the same socket is free.
 */
export function socketIoTools(
  socket: SocketLike,
  options: SocketIoToolsOptions = {},
): Tools {
  let tap = taps.get(socket)
  if (!tap) taps.set(socket, (tap = install(socket, options)))
  return tap.tools
}
