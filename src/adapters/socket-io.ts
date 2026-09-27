import { fakeableConnection, realtimeAdapter, tapListeners } from '../realtime/patch'
import { createRealtimeTap } from '../realtime/tap'

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

// Lifecycle events, not messages. Faked through realtime.connection instead.
const RESERVED = new Set([
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener',
])

/**
 * See, fake and drop socket.io events: `realtime.*`, where a channel is an
 * event name. Patches the socket, so call it where you create the socket,
 * before the app adds listeners. Calling it again with the same socket is free.
 */
export const socketIoTools = realtimeAdapter(
  (socket: SocketLike, options: SocketIoToolsOptions) => {
    const tap = createRealtimeTap<unknown[]>({
      namespace: options.namespace,
      // The last argument is an ack callback when the server asked for one.
      describe: (args) => {
        const values = args.filter((a) => typeof a !== 'function')
        return { data: values.length === 1 ? values[0] : values }
      },
      toMessage: (values) => values,
      // socket.io-client announces lifecycle events with emitReserved.
      connection: fakeableConnection(socket, {
        property: 'connected',
        events: 'emitReserved',
        states: ['connected', 'disconnected'],
        read: (connected) => (connected ? 'connected' : 'disconnected'),
        // socket.io reads `connected` to decide whether to deliver incoming
        // events and send outgoing ones; faking it would hold them back.
        fakeProperty: false,
        announce: (emit, { current }) =>
          current === 'connected'
            ? emit('connect')
            : emit('disconnect', 'transport close'),
      }),
    })
    // `once` goes through on/off, so it needs no patch of its own.
    tapListeners(tap, socket, {
      add: ['on', 'addEventListener'],
      remove: ['off', 'removeListener', 'removeAllListeners', 'removeEventListener'],
      channel: ([event]) =>
        typeof event === 'string' && !RESERVED.has(event) ? event : undefined,
      message: 'args',
    })
    return tap
  },
)
