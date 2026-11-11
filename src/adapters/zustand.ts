import type { Tools } from '../runtime/types'
import {
  type Redact,
  differences,
  isObject,
  readState,
  redactValue,
} from './store-common'

export type { Redact }

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
export type StoreToolsOptions = { redact?: Redact }


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
        'Shallow-merge a partial into a store. Returns only the keys you set, with their new values, not the whole store. A store is snapshotted on its first store.set or store.call since the last restore (or store.commit); bridge.restore puts that snapshot back. Changes made before that, e.g. by tapping the UI, are not in it: run store.set <store> {} first to snapshot early, and see bridge.pending.',
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
        'Call an action on a store, e.g. ("settings", "setColorScheme", "dark"). Returns the action\'s return value, or { changed: [keys] } when it returns nothing or the store state. Snapshots the store first, like store.set: the first store.set or store.call since the last restore is the state bridge.restore returns to.',
      run: async (name: string, action: string, ...args: unknown[]) => {
        const store = get(name)
        const fn = (store.getState() as Record<string, unknown>)[action]
        if (typeof fn !== 'function')
          throw new Error(`Store "${name}" has no action "${action}"`)
        beforeChange(store)
        const before = store.getState()
        const result = await (fn as (...a: unknown[]) => unknown)(...args)
        const after = store.getState()
        if (result !== undefined && result !== before && result !== after) {
          // An action often returns a piece of its own state; redact that by
          // the path it lives at. A copy or derived value isn't found by
          // identity, so its paths are relative to the result.
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
    'store.commit': {
      maxArgs: 1,
      description:
        'Keep a store as it is now: drops its pending snapshot, so bridge.restore leaves it alone and the next store.set or store.call snapshots again from this state. Use it after repairing a value that was already wrong when the snapshot was taken. Returns { store, committed } (committed: false when nothing was pending).',
      run: (name: string) => {
        const store = get(name)
        return { store: name, committed: snapshots.delete(store) }
      },
    },
    'store.restore': {
      maxArgs: 0,
      // Per store, its snapshot against now (secrets redacted), so an agent can
      // tell what a restore will put back before it does.
      pending: ({ detail }: { detail?: boolean } = {}) => {
        const changed = Object.entries(stores).filter(([, s]) => snapshots.has(s))
        if (!changed.length) return false
        // Replies only need to know something is pending; bridge.pending asks for detail.
        if (!detail) return true
        return Object.fromEntries(
          changed.map(([name, store]) => [
            name,
            differences(snapshots.get(store), store.getState(), (key, value) =>
              out(name, value, key),
            ),
          ]),
        )
      },
      description:
        'Undo the agent: put back each store changed with store.set or store.call, to its state at the first of those (store.commit drops a snapshot). Returns their names.',
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
