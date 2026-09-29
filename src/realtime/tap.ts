import type { Tools } from '../runtime/types'

export const LOG_SIZE = 50

/** How a message shows up in `realtime.log`. */
export type MessageSummary = {
  /** The event or message name, when the library has one. */
  event?: string
  data?: unknown
  id?: string
}

/** Lets the agent fake the client's connection state. */
export type RealtimeConnection = {
  /** The client's real state, e.g. "connected". */
  state: () => string
  /**
   * Show `state` to the app instead of the real one, as if the client had
   * moved there from `previous`. `null` goes back to the real state.
   */
  fake: (state: string | null, previous: string) => void
  /** States the agent may pick, for error messages. */
  states?: readonly string[]
  /** The state in which real messages flow. Defaults to "connected". */
  live?: string
}

export type RealtimeTapOptions<M> = {
  /** Tool name prefix. Defaults to "realtime"; set it when an app has two taps. */
  namespace?: string
  /** What to log for a message. Defaults to the message as `data`, with its `id` if it has one. */
  describe?: (message: M) => MessageSummary
  /**
   * Builds the message `realtime.emit` delivers, from the JSON values the
   * agent passed after the channel. Defaults to the first value.
   */
  toMessage?: (values: unknown[], context: { channel: string; id: string }) => M
  /** Extra fields for `realtime.channels`, e.g. the library's channel state. */
  channelInfo?: (channel: string) => Record<string, unknown>
  /** Adds `realtime.connection`, to fake connection states. */
  connection?: RealtimeConnection
}

export type WrapOptions<M> = {
  /**
   * Whether this listener would get the message from the library, e.g. an
   * event-name filter. Injected messages skip listeners that say no.
   */
  accepts?: (message: M) => boolean
}

export type RealtimeTap<M> = {
  /**
   * Wraps the app's listener for `channel`. Hand `listener` to the library
   * instead of the original, and call `unsubscribe` when the app unsubscribes.
   * Arguments after the message reach the app's listener untouched.
   */
  wrap: (
    channel: string,
    listener: (message: M, ...rest: never[]) => void,
    options?: WrapOptions<M>,
  ) => {
    listener: (message: M, ...rest: unknown[]) => void
    unsubscribe: () => void
  }
  /** `realtime.*`, or `<namespace>.*`. */
  tools: Tools
}

export type RealtimeLogEntry = MessageSummary & {
  at: string
  channel: string
  injected: boolean
  /** Why the app didn't get it. */
  dropped?: 'muted' | 'connection'
}

type Entry<M> = {
  deliver: (message: M, ...rest: unknown[]) => void
  accepts?: (message: M) => boolean
}

type Mute = { dropInjected: boolean }

const ALL = '*'

const defaultDescribe = (message: unknown): MessageSummary => {
  const id = (message as { id?: unknown } | null)?.id
  return typeof id === 'string' ? { data: message, id } : { data: message }
}

// Libraries hand one message to every listener, but some (socket.io) as a
// fresh argument list each time, so equal lists count as the same message.
const sameMessage = (a: unknown, b: unknown) =>
  a === b ||
  (Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((v, i) => v === b[i]))

/**
 * Lets the agent see, fake and drop realtime messages, whatever library
 * delivers them. Wrap each listener with `wrap`, and add `tools` to the bridge.
 */
export function createRealtimeTap<M = unknown>(
  options: RealtimeTapOptions<M> = {},
): RealtimeTap<M> {
  const ns = options.namespace ?? 'realtime'
  const describe = options.describe ?? (defaultDescribe as (m: M) => MessageSummary)
  const toMessage = options.toMessage ?? ((values: unknown[]) => values[0] as M)
  const connection = options.connection
  const live = connection?.live ?? 'connected'

  const channels = new Map<string, Set<Entry<M>>>()
  const mutes = new Map<string, Mute>()
  const log: RealtimeLogEntry[] = []
  // The last real message per channel and the listeners it has reached, so a
  // message fanned out to several listeners is logged once.
  const last = new Map<string, { message: M; seen: Set<Entry<M>> }>()
  let injectedCount = 0
  let faked: string | null = null

  const muteFor = (channel: string) => mutes.get(channel) ?? mutes.get(ALL)
  const liveChannels = () => [...channels.keys()].join(', ') || 'none'

  function record(
    channel: string,
    message: M,
    injected: boolean,
    dropped?: RealtimeLogEntry['dropped'],
  ) {
    log.push({
      at: new Date().toISOString(),
      channel,
      ...describe(message),
      injected,
      ...(dropped && { dropped }),
    })
    if (log.length > LOG_SIZE) log.splice(0, log.length - LOG_SIZE)
  }

  function receive(
    channel: string,
    entry: Entry<M>,
    message: M,
    rest: unknown[],
  ) {
    const previous = last.get(channel)
    const dropped = muteFor(channel)
      ? 'muted'
      : faked !== null && faked !== live
        ? 'connection'
        : undefined
    if (
      previous &&
      !previous.seen.has(entry) &&
      sameMessage(previous.message, message)
    ) {
      previous.seen.add(entry)
    } else {
      last.set(channel, { message, seen: new Set([entry]) })
      record(channel, message, false, dropped)
    }
    if (!dropped) entry.deliver(message, ...rest)
  }

  const wrap: RealtimeTap<M>['wrap'] = (channel, listener, wrapOptions = {}) => {
    const entry: Entry<M> = {
      deliver: listener as Entry<M>['deliver'],
      accepts: wrapOptions.accepts,
    }
    let entries = channels.get(channel)
    if (!entries) channels.set(channel, (entries = new Set()))
    entries.add(entry)
    return {
      listener: (message, ...rest) => receive(channel, entry, message, rest),
      unsubscribe: () => {
        const current = channels.get(channel)
        if (!current?.delete(entry) || current.size) return
        channels.delete(channel)
        last.delete(channel)
      },
    }
  }

  function setMute(channel: string, mute: Mute | null) {
    if (typeof channel !== 'string' || !channel)
      throw new Error(`Pass a channel name, or "${ALL}" for every channel`)
    if (mute) mutes.set(channel, mute)
    else if (channel === ALL) mutes.clear()
    else mutes.delete(channel)
    return { muted: [...mutes.keys()] }
  }

  function setConnection(conn: RealtimeConnection, state: string | null) {
    const shown = faked ?? conn.state()
    if (state !== null && typeof state !== 'string')
      throw new Error('Pass a state such as "disconnected", or null for the real one')
    if (state !== null && conn.states && !conn.states.includes(state))
      throw new Error(
        `Unknown state "${state}". Known: ${conn.states.join(', ')}`,
      )
    if (state === faked) return
    faked = state
    conn.fake(state, shown)
  }

  const tools: Tools = {
    [`${ns}.channels`]: {
      description:
        'Channels the app listens on: listener count, muted, and what the library says about each.',
      run: () =>
        [...channels].map(([name, entries]) => ({
          name,
          listeners: entries.size,
          muted: Boolean(muteFor(name)),
          ...options.channelInfo?.(name),
        })),
    },
    [`${ns}.log`]: {
      description: `Recent messages, real and injected, newest first (last ${LOG_SIZE}). Filter: { channel?, event?, limit? }; clear: true empties the log after reading.`,
      run: (
        filter: {
          channel?: string
          event?: string
          limit?: number
          clear?: boolean
        } = {},
      ) => {
        const entries = log
          .filter(
            (e) =>
              (!filter.channel || e.channel === filter.channel) &&
              (!filter.event || e.event === filter.event),
          )
          .reverse()
          .slice(0, filter.limit ?? 20)
        if (filter.clear) log.length = 0
        return entries
      },
    },
    [`${ns}.emit`]: {
      description:
        'Deliver a fake message to every listener on a channel: [channel, message]. Runs the app\'s own handlers. Returns { id, delivered }.',
      run: (channel: string, ...values: unknown[]) => {
        const entries = channels.get(channel)
        if (!entries?.size)
          throw new Error(
            `Nothing listens on "${channel}". Live channels: ${liveChannels()}`,
          )
        injectedCount += 1
        const message = toMessage(values, {
          channel,
          id: `agent-bridge-${injectedCount}`,
        })
        // The message may carry the agent's own id, e.g. to test dedup.
        const id = describe(message).id
        if (muteFor(channel)?.dropInjected) {
          record(channel, message, true, 'muted')
          return { id, delivered: 0 }
        }
        record(channel, message, true)
        let delivered = 0
        for (const entry of [...entries]) {
          if (entry.accepts && !entry.accepts(message)) continue
          entry.deliver(message)
          delivered += 1
        }
        return { id, delivered }
      },
    },
    [`${ns}.mute`]: {
      description: `Drop real messages on a channel ("${ALL}" for all) until unmuted. Injected messages still get through unless { dropInjected: true }.`,
      run: (channel: string, muteOptions: { dropInjected?: boolean } = {}) =>
        setMute(channel, { dropInjected: Boolean(muteOptions.dropInjected) }),
    },
    [`${ns}.unmute`]: {
      description: `Stop dropping messages on a channel ("${ALL}" for all).`,
      run: (channel: string) => setMute(channel, null),
    },
    [`${ns}.restore`]: {
      pending: () => mutes.size > 0 || faked !== null,
      description:
        'Undo the agent: unmute every channel and go back to the real connection state.',
      run: () => {
        const unmuted = [...mutes.keys()]
        mutes.clear()
        const connectionFaked = faked !== null
        if (connection && connectionFaked) setConnection(connection, null)
        return { unmuted, connectionFaked }
      },
    },
  }

  if (connection)
    tools[`${ns}.connection`] = {
      description: `The connection state, or fake one: [state] shows the app that state${connection.states ? ` (${connection.states.join(', ')})` : ''} and drops real messages unless it is "${live}"; [null] goes back to the real one.`,
      run: (...args: [(string | null)?]) => {
        if (args.length) setConnection(connection, args[0] ?? null)
        return { state: faked ?? connection.state(), real: connection.state(), faked: faked !== null }
      },
    }

  return { wrap, tools }
}
