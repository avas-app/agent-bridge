import type { Tools } from '../runtime/types'
import type { RealtimeConnection, RealtimeTap } from './tap'

// oxlint-disable-next-line no-explicit-any -- patched methods take whatever the library takes
type AnyFn = (...args: any[]) => unknown
type Methods = Record<string, AnyFn | undefined>

export type TapListenersOptions<M> = {
  /** Methods that add a listener, e.g. "on" or ["on", "addEventListener"]. */
  add: string | string[]
  /** Methods that remove one, e.g. "off". */
  remove: string | string[]
  /**
   * The channel a call is for, from the arguments before the listener (its
   * "key", e.g. the event name). Return undefined to leave the call alone.
   */
  channel: (key: unknown[]) => string | undefined
  /** Whether a listener added with `key` would get `message`, e.g. an event-name filter. */
  accepts?: (key: unknown[], message: M) => boolean
  /**
   * "first" (default): the message is the listener's first argument, and the
   * rest reach the listener untouched. "args": every argument, as an array.
   */
  message?: 'first' | 'args'
}

type Tracked = {
  key: unknown[]
  original: AnyFn & { fn?: AnyFn }
  wrapped: AnyFn
  unsubscribe: () => void
}

const list = (names: string | string[]) => (Array.isArray(names) ? names : [names])
const sameKey = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b)

// The listener is the last argument; everything before it is the key.
function split(args: unknown[]): { key: unknown[]; listener?: AnyFn } {
  const last = args[args.length - 1]
  return typeof last === 'function'
    ? { key: args.slice(0, -1), listener: last as AnyFn }
    : { key: args }
}

/**
 * Routes a client's add/remove-listener methods through `tap`, e.g.
 * `socket.on` / `socket.off` or `channel.subscribe` / `channel.unsubscribe`.
 * Removing works in every usual form: all, by key, by listener, or both.
 */
export function tapListeners<M>(
  tap: RealtimeTap<M>,
  target: object,
  options: TapListenersOptions<M>,
): void {
  const methods = target as Methods
  const tracked: Tracked[] = []
  const spread = options.message === 'args'

  for (const name of list(options.add)) {
    const add = methods[name]
    if (typeof add !== 'function') continue
    methods[name] = function (this: unknown, ...args: unknown[]) {
      const { key, listener: original } = split(args)
      const channel = original && options.channel(key)
      if (!original || channel === undefined) return add.apply(this, args)
      const accepts = options.accepts
      const { listener, unsubscribe } = tap.wrap(
        channel,
        (message: M, ...rest: unknown[]) =>
          spread
            ? original.apply(target, message as unknown[])
            : original.call(target, message, ...rest),
        accepts ? { accepts: (m) => accepts(key, m) } : {},
      )
      const wrapped: AnyFn = spread
        ? (...received: unknown[]) => listener(received as M)
        : (message: M, ...rest: unknown[]) => listener(message, ...rest)
      tracked.push({ key, original, wrapped, unsubscribe })
      return add.apply(this, [...key, wrapped])
    }
  }

  for (const name of list(options.remove)) {
    const remove = methods[name]
    if (typeof remove !== 'function') continue
    methods[name] = function (this: unknown, ...args: unknown[]) {
      const { key, listener } = split(args)
      // `.fn`: emitter-style once() wrappers point at the listener they wrap.
      const hits = tracked.filter(
        (t) =>
          (!listener || t.original === listener || t.original.fn === listener) &&
          (!key.length || sameKey(t.key, key)),
      )
      for (const hit of hits) {
        tracked.splice(tracked.indexOf(hit), 1)
        hit.unsubscribe()
      }
      if (!listener || !hits.length) return remove.apply(this, args)
      let result: unknown
      for (const hit of hits) result = remove.apply(this, [...hit.key, hit.wrapped])
      return result
    }
  }
}

export type FakeableConnectionOptions = {
  /** The property holding the state, e.g. "state" or "connected". */
  property: string
  /** The method the client tells listeners about changes with. Silent while a state is faked. */
  events: string
  /** States the agent may pick. */
  states: readonly string[]
  /** The state in which real messages flow. Defaults to "connected". */
  live?: string
  /** Property value to state name. Defaults to the value itself. */
  read?: (value: unknown) => string
  /** State name to property value. Defaults to the name itself. */
  write?: (state: string) => unknown
  /** Tells the app about a change, through the client's own (unsilenced) events method. */
  announce: (
    emit: (...args: unknown[]) => void,
    change: { current: string; previous: string; faked: boolean },
  ) => void
}

/**
 * Lets `realtime.connection` fake a client's connection state: the property
 * reads the fake, real changes still land underneath but aren't announced,
 * and going back announces the real state. Undefined when `target` lacks
 * the events method, so the tool is left out rather than broken.
 */
export function fakeableConnection(
  target: object | undefined,
  options: FakeableConnectionOptions,
): RealtimeConnection | undefined {
  const methods = target as Methods | undefined
  const events = methods?.[options.events]
  if (!methods || typeof events !== 'function') return undefined
  const read = options.read ?? String
  const write = options.write ?? ((state: string) => state)
  let real = (methods as Record<string, unknown>)[options.property]
  let fake: string | null = null
  Object.defineProperty(target, options.property, {
    configurable: true,
    enumerable: true,
    get: () => (fake === null ? real : write(fake)),
    set: (value: unknown) => {
      real = value
    },
  })
  methods[options.events] = function (this: unknown, ...args: unknown[]) {
    return fake === null ? events.apply(this, args) : undefined
  }
  const emit = (...args: unknown[]) => void events.apply(target, args)
  return {
    state: () => read(real),
    states: options.states,
    live: options.live,
    fake: (state, previous) => {
      fake = state
      const current = state ?? read(real)
      if (current !== previous)
        options.announce(emit, { current, previous, faked: state !== null })
    },
  }
}

/**
 * Turns an install function into an adapter's `xxxTools(client, options)`.
 * The client is patched on the first call; later calls return the same tools.
 */
export function realtimeAdapter<C extends object, O extends object>(
  install: (client: C, options: O) => Pick<RealtimeTap<unknown>, 'tools'>,
): (client: C, options?: O) => Tools {
  const taps = new WeakMap<C, Tools>()
  return (client, options = {} as O) => {
    let tools = taps.get(client)
    if (!tools) taps.set(client, (tools = install(client, options).tools))
    return tools
  }
}
