import type { Tools } from '../runtime/types'

/** Anything with zustand's store shape. */
export type StoreLike = {
  getState: () => unknown
  /**
   * `replace: true` swaps the whole state, as zustand's setState does. Method
   * syntax, so zustand's overloads (replace: false | true) still fit.
   */
  setState(partial: Record<string, unknown>, replace?: boolean): void
}

// State from before the agent's first change, per store object, so tools
// rebuilt on every render still find it.
const snapshots = new WeakMap<StoreLike, unknown>()

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

type Path = Array<string | number>

/** A path as dotted string ("auth.isLoggedIn") or array of segments. */
function toPath(part: unknown): Path {
  if (typeof part === 'string') return part === '' ? [] : part.split('.')
  if (typeof part === 'number') return [part]
  if (
    Array.isArray(part) &&
    part.every((p) => typeof p === 'string' || typeof p === 'number')
  )
    return part
  throw new Error(
    `A store path is a dotted string or an array of segments, got ${JSON.stringify(part)}`,
  )
}

function at(value: unknown, path: Path): unknown {
  return path.reduce<unknown>(
    (v, k) => (v as Record<string, unknown> | undefined)?.[k],
    value,
  )
}

const kindOf = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v

type GetOptions = { pick?: unknown[]; keys?: boolean }

// store.get("s", "a", "b.c", ["d"], { pick }): everything between the name
// and a trailing options object is the path.
function readState(state: unknown, given: unknown[]): unknown {
  // null and undefined mean no path or options.
  const args = given.filter((a) => a != null)
  const last = args.at(-1)
  const isOptions = isObject(last) && !Array.isArray(last)
  const options = (isOptions ? last : {}) as GetOptions
  const unknown = Object.keys(options).filter((k) => k !== 'pick' && k !== 'keys')
  if (unknown.length)
    throw new Error(
      `Unknown store.get option ${unknown.map((k) => `"${k}"`).join(', ')}. Options: pick, keys`,
    )
  const value = at(state, (isOptions ? args.slice(0, -1) : args).flatMap(toPath))
  if (options.pick !== undefined) {
    if (!Array.isArray(options.pick))
      throw new Error('store.get pick is an array of paths')
    return Object.fromEntries(
      options.pick.map((p) => [
        Array.isArray(p) ? p.join('.') : String(p),
        at(value, toPath(p)),
      ]),
    )
  }
  if (options.keys)
    return isObject(value)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, kindOf(v)]))
      : kindOf(value)
  return value
}

// Puts the snapshot's data back and drops keys added since. Actions come from
// the current state, so they keep working.
function restore(store: StoreLike, snapshot: unknown) {
  const current = store.getState()
  if (!isObject(snapshot) || !isObject(current)) {
    store.setState(snapshot as Record<string, unknown>, true)
    return
  }
  const actions = Object.fromEntries(
    Object.entries(current).filter(([, v]) => typeof v === 'function'),
  )
  store.setState({ ...snapshot, ...actions }, true)
}

/**
 * Keeps secrets out of what store.* prints. Either dotted paths per store
 * (`{ auth: ['accessToken', 'user.phone'] }`), or a hook called for the store
 * value and every nested value with its dotted path; what it returns is
 * printed instead.
 */
export type Redact =
  | Record<string, string[]>
  | ((store: string, path: string, value: unknown) => unknown)

export type StoreToolsOptions = { redact?: Redact }

const REDACTED = '[redacted]'

function redactValue(
  redact: Redact | undefined,
  name: string,
  value: unknown,
  path: string,
  seen: object[] = [],
): unknown {
  if (!redact || typeof value === 'function') return value
  if (typeof redact === 'function') {
    if (path) value = redact(name, path, value)
  } else if (
    path &&
    redact[name]?.some((p) => path === p || path.startsWith(`${p}.`))
  ) {
    return REDACTED
  }
  if (!isObject(value) || seen.includes(value)) return value
  const next = [...seen, value]
  const entries = Object.entries(value).map(([k, v]) => [
    k,
    redactValue(redact, name, v, path ? `${path}.${k}` : k, next),
  ])
  return Array.isArray(value)
    ? entries.map(([, v]) => v)
    : Object.fromEntries(entries)
}

/** Read, merge into, and call actions on named stores. */
export function storeTools(
  stores: Record<string, StoreLike>,
  options: StoreToolsOptions = {},
): Tools {
  const out = (name: string, value: unknown, path = '') =>
    redactValue(options.redact, name, value, path)
  const get = (name: string) => {
    const store = stores[name]
    if (!store)
      throw new Error(
        `Unknown store "${name}". Known: ${Object.keys(stores).join(', ')}`,
      )
    return store
  }
  const beforeChange = (store: StoreLike) => {
    if (!snapshots.has(store)) snapshots.set(store, store.getState())
  }

  return {
    'store.list': {
      description: 'Store names.',
      maxArgs: 0,
      run: () => Object.keys(stores),
    },
    'store.get': {
      description:
        'State of a store, or a path inside it: ("auth", "auth.isLoggedIn"), ("auth", "auth", "isLoggedIn") or ("auth", ["auth", "isLoggedIn"]). A last { pick: ["a.b", "c"] } returns just those fields; { keys: true } lists keys and their types without values. Paths configured with redact print as "[redacted]".',
      // Redact the whole state first, so paths, pick and keys all see it.
      run: (name: string, ...rest: unknown[]) =>
        readState(out(name, get(name).getState()), rest),
    },
    'store.set': {
      description:
        'Shallow-merge a partial into a store. Returns only the keys you set, with their new values, not the whole store.',
      run: (name: string, partial: Record<string, unknown>) => {
        const store = get(name)
        beforeChange(store)
        store.setState(partial)
        const state = store.getState() as Record<string, unknown>
        return out(
          name,
          Object.fromEntries(Object.keys(partial).map((k) => [k, state[k]])),
        )
      },
    },
    'store.call': {
      description:
        'Call an action on a store, e.g. ("settings", "setColorScheme", "dark"). Returns the action\'s return value, or { changed: [keys] } when it returns nothing or the store state.',
      run: (name: string, action: string, ...args: unknown[]) => {
        const store = get(name)
        const fn = (store.getState() as Record<string, unknown>)[action]
        if (typeof fn !== 'function')
          throw new Error(`Store "${name}" has no action "${action}"`)
        beforeChange(store)
        const before = store.getState()
        const result = (fn as (...a: unknown[]) => unknown)(...args)
        const after = store.getState()
        if (result !== undefined && result !== before && result !== after)
        {
          // An action often returns a piece of its own state; redact that by
          // the path it lives at.
          const key = isObject(after)
            ? Object.keys(after).find((k) => after[k] === result)
            : undefined
          return out(name, result, key)
        }
        const a = before as Record<string, unknown>
        const b = after as Record<string, unknown>
        return {
          changed: Object.keys(b).filter(
            (k) => typeof b[k] !== 'function' && !Object.is(a?.[k], b[k]),
          ),
        }
      },
    },
    'store.restore': {
      maxArgs: 0,
      description:
        'Undo the agent: put back each store changed with store.set or store.call. Returns their names.',
      run: () =>
        Object.entries(stores).flatMap(([name, store]) => {
          if (!snapshots.has(store)) return []
          restore(store, snapshots.get(store))
          snapshots.delete(store)
          return [name]
        }),
    },
  }
}
