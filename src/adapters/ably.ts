import { fakeableConnection, realtimeAdapter, tapListeners } from '../realtime/patch'
import { createRealtimeTap } from '../realtime/tap'

/** The fields of an Ably message this adapter reads. */
export type AblyMessageLike = {
  id?: string
  name?: string
  data?: unknown
  clientId?: string
  connectionId?: string
  extras?: unknown
  timestamp?: number
  action?: string
  serial?: string
  version?: unknown
  annotations?: unknown
}

/** The Ably realtime channel surface this adapter uses. */
export type AblyChannelLike = {
  name: string
  state?: string
  subscribe(...args: never[]): unknown
  unsubscribe(...args: never[]): unknown
}

/** An Ably realtime client (`new Ably.Realtime(...)`), typed structurally. */
export type AblyRealtimeLike = {
  channels: { get(name: string, ...rest: never[]): AblyChannelLike }
  connection?: { state: string }
}

export type AblyToolsOptions = {
  /** Tool name prefix. Defaults to "realtime". */
  namespace?: string
}

const CONNECTION_STATES = [
  'initialized',
  'connecting',
  'connected',
  'disconnected',
  'suspended',
  'closing',
  'closed',
  'failed',
] as const

// Whether a listener subscribed with `filter` would get the message: an event
// name, a list of them, or a MessageFilter (only name and clientId are checked).
function accepts(filter: unknown, message: AblyMessageLike): boolean {
  if (typeof filter === 'string') return message.name === filter
  if (Array.isArray(filter)) return filter.includes(message.name)
  if (filter && typeof filter === 'object') {
    const { name, clientId } = filter as AblyMessageLike
    return (
      (name === undefined || name === message.name) &&
      (clientId === undefined || clientId === message.clientId)
    )
  }
  return true
}

const USAGE =
  'Pass the message as { name, data }, e.g. ["chat", { "name": "typing", "data": { "user": "sam" } }]'

// The fields ably-js puts on a message it decoded off the wire. Anything the
// agent passes overrides these; `name` is the event name and stays unset unless given.
function toMessage(values: unknown[], { id }: { id: string }): AblyMessageLike {
  const [input] = values
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(USAGE)
  const given = input as AblyMessageLike & { event?: unknown }
  if (given.name === undefined && given.event !== undefined)
    throw new Error(`Ably messages have "name", not "event". ${USAGE}`)
  const timestamp = Date.now()
  return {
    id,
    timestamp,
    action: 'message.create',
    version: { timestamp },
    annotations: { summary: {} },
    ...given,
  }
}

/**
 * See, fake and drop Ably messages: `realtime.*`. Patches the client, so call
 * it where you create the client, before the app subscribes; listeners added
 * earlier stay invisible. Calling it again with the same client is free.
 */
export const ablyTools = realtimeAdapter(
  (client: AblyRealtimeLike, options: AblyToolsOptions) => {
    const channels = new Map<string, AblyChannelLike>()
    const tap = createRealtimeTap<AblyMessageLike>({
      namespace: options.namespace,
      describe: (m) => ({ event: m.name, data: m.data, id: m.id }),
      toMessage,
      emitUsage:
        'Ably: [channel, { name, data, clientId?, extras? }]. "name" is the event name (subscribe filters and message.name see it) and "data" the payload; there is no "event" field. Filled in like a real message: id, timestamp, action, version, annotations.',
      channelInfo: (name) => ({ state: channels.get(name)?.state }),
      // ably-js's connection is an event emitter; `emit` isn't in its public types.
      connection: fakeableConnection(client.connection, {
        property: 'state',
        events: 'emit',
        states: CONNECTION_STATES,
        announce: (emit, { current, previous, faked }) =>
          emit(current, {
            previous,
            current,
            event: current,
            ...(faked && { reason: { message: 'Faked by agent-bridge' } }),
          }),
      }),
    })

    const patch = (channel: AblyChannelLike) => {
      if (!channel || channels.get(channel.name) === channel) return channel
      channels.set(channel.name, channel)
      tapListeners(tap, channel, {
        add: 'subscribe',
        remove: 'unsubscribe',
        channel: () => channel.name,
        accepts: ([filter], message) => accepts(filter, message),
      })
      return channel
    }

    // Channels come from channels.get(), including ones created before this.
    const registry = client.channels as AblyRealtimeLike['channels'] & {
      all?: Record<string, AblyChannelLike>
    }
    const get = registry.get as (...args: unknown[]) => AblyChannelLike
    registry.get = function (this: unknown, ...args: unknown[]) {
      return patch(get.apply(this, args))
    } as AblyRealtimeLike['channels']['get']
    for (const channel of Object.values(registry.all ?? {})) patch(channel)
    return tap
  },
)
