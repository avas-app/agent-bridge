import { createRealtimeTap, type RealtimeConnection, type RealtimeTap } from '../realtime/tap'
import type { Tools } from '../runtime/types'

/** The fields of an Ably message this adapter reads. */
export type AblyMessageLike = {
  id?: string
  name?: string
  data?: unknown
  clientId?: string
}

type Fn = (...args: never[]) => unknown

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

type Listener = (message: AblyMessageLike) => void
type Tracked = {
  filter: unknown
  original: Listener
  wrapped: Listener
  unsubscribe: () => void
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

const taps = new WeakMap<object, RealtimeTap<AblyMessageLike>>()

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

const sameFilter = (a: unknown, b: unknown) =>
  a === b || JSON.stringify(a) === JSON.stringify(b)

function toMessage(values: unknown[], { id }: { id: string }): AblyMessageLike {
  const [input] = values
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Pass the message as { name, data }, e.g. ["chat", { "name": "typing", "data": { "user": "sam" } }]')
  return { id, timestamp: Date.now(), ...input } as AblyMessageLike
}

// Fakes connection states through the connection's own events. Needs ably-js's
// `emit`, which isn't in its public types, so the tool is left out without it.
function fakeableConnection(
  connection: AblyRealtimeLike['connection'],
): RealtimeConnection | undefined {
  const conn = connection as
    | (NonNullable<typeof connection> & { emit?: Fn })
    | undefined
  const emit = conn?.emit
  if (!conn || typeof emit !== 'function') return undefined
  let real = conn.state
  let fake: string | null = null
  Object.defineProperty(conn, 'state', {
    configurable: true,
    enumerable: true,
    get: () => fake ?? real,
    set: (value: string) => {
      real = value
    },
  })
  // While a state is faked, the app hears nothing about the real one.
  conn.emit = function (this: unknown, ...args: never[]) {
    return fake === null ? emit.apply(this, args) : undefined
  }
  return {
    state: () => real,
    states: CONNECTION_STATES,
    fake: (state, previous) => {
      fake = state
      const current = state ?? real
      if (current === previous) return
      const reason = state ? { message: 'Faked by agent-bridge' } : undefined
      ;(emit as (...args: unknown[]) => unknown).call(conn, current, {
        previous,
        current,
        event: current,
        ...(reason && { reason }),
      })
    },
  }
}

function install(
  client: AblyRealtimeLike,
  options: AblyToolsOptions,
): RealtimeTap<AblyMessageLike> {
  const channels = new Map<string, AblyChannelLike>()
  const tap = createRealtimeTap<AblyMessageLike>({
    namespace: options.namespace,
    describe: (m) => ({ event: m.name, data: m.data, id: m.id }),
    toMessage,
    channelInfo: (name) => ({ state: channels.get(name)?.state }),
    connection: fakeableConnection(client.connection),
  })
  const patched = new WeakSet<AblyChannelLike>()

  function patch(channel: AblyChannelLike): AblyChannelLike {
    if (!channel || patched.has(channel)) return channel
    patched.add(channel)
    channels.set(channel.name, channel)
    const subscribe = channel.subscribe as (...args: unknown[]) => unknown
    const unsubscribe = channel.unsubscribe as (...args: unknown[]) => unknown
    const tracked: Tracked[] = []

    // subscribe(listener), subscribe(event | events | filter, listener)
    channel.subscribe = function (this: unknown, ...args: unknown[]) {
      const at = args.findIndex((a) => typeof a === 'function')
      if (at < 0) return subscribe.apply(this, args)
      const original = args[at] as Listener
      const filter = at > 0 ? args[0] : undefined
      const { listener: wrapped, unsubscribe: forget } = tap.wrap(
        channel.name,
        (message) => original.call(channel, message),
        filter === undefined ? {} : { accepts: (m) => accepts(filter, m) },
      )
      tracked.push({ filter, original, wrapped, unsubscribe: forget })
      const next = [...args]
      next[at] = wrapped
      return subscribe.apply(this, next)
    } as AblyChannelLike['subscribe']

    // unsubscribe(), unsubscribe(listener), unsubscribe(event | filter[, listener])
    channel.unsubscribe = function (this: unknown, ...args: unknown[]) {
      const at = args.findIndex((a) => typeof a === 'function')
      const listener = at >= 0 ? (args[at] as Listener) : undefined
      const filter = at === 0 ? undefined : args[0]
      const hits = tracked.filter(
        (t) =>
          (!listener || t.original === listener) &&
          (filter === undefined || sameFilter(t.filter, filter)),
      )
      for (const hit of hits) {
        tracked.splice(tracked.indexOf(hit), 1)
        hit.unsubscribe()
      }
      if (!listener || !hits.length) return unsubscribe.apply(this, args)
      for (const hit of hits)
        unsubscribe.apply(
          this,
          filter === undefined ? [hit.wrapped] : [filter, hit.wrapped],
        )
      return undefined
    } as AblyChannelLike['unsubscribe']
    return channel
  }

  const registry = client.channels as AblyRealtimeLike['channels'] & {
    all?: Record<string, AblyChannelLike>
  }
  const get = registry.get as (...args: unknown[]) => AblyChannelLike
  registry.get = function (this: unknown, ...args: unknown[]) {
    return patch(get.apply(this, args))
  } as AblyRealtimeLike['channels']['get']
  for (const channel of Object.values(registry.all ?? {})) patch(channel)
  return tap
}

/**
 * See, fake and drop Ably messages: `realtime.*`. Patches the client, so call
 * it where you create the client, before the app subscribes; listeners added
 * earlier stay invisible. Calling it again with the same client is free.
 */
export function ablyTools(
  client: AblyRealtimeLike,
  options: AblyToolsOptions = {},
): Tools {
  let tap = taps.get(client)
  if (!tap) taps.set(client, (tap = install(client, options)))
  return tap.tools
}
