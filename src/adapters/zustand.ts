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

function pick(value: unknown, path?: string): unknown {
  if (!path) return value
  return path
    .split('.')
    .reduce<unknown>(
      (v, k) => (v as Record<string, unknown> | undefined)?.[k],
      value,
    )
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

/** Read, merge into, and call actions on named stores. */
export function storeTools(stores: Record<string, StoreLike>): Tools {
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
      run: () => Object.keys(stores),
    },
    'store.get': {
      description:
        'State of a store, or one dotted path inside it (e.g. "auth.isLoggedIn").',
      run: (name: string, path?: string) => pick(get(name).getState(), path),
    },
    'store.set': {
      description: 'Shallow-merge a partial into a store.',
      run: (name: string, partial: Record<string, unknown>) => {
        const store = get(name)
        beforeChange(store)
        store.setState(partial)
        return store.getState()
      },
    },
    'store.call': {
      description:
        'Call an action on a store, e.g. ("settings", "setColorScheme", "dark").',
      run: (name: string, action: string, ...args: unknown[]) => {
        const store = get(name)
        const fn = (store.getState() as Record<string, unknown>)[action]
        if (typeof fn !== 'function')
          throw new Error(`Store "${name}" has no action "${action}"`)
        beforeChange(store)
        return (fn as (...a: unknown[]) => unknown)(...args)
      },
    },
    'store.restore': {
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
