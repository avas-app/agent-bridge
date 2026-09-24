import type { Tools } from '../runtime/types'

/** Anything with zustand's store shape. */
export type StoreLike = {
  getState: () => unknown
  setState: (partial: Record<string, unknown>) => void
}

function pick(value: unknown, path?: string): unknown {
  if (!path) return value
  return path
    .split('.')
    .reduce<unknown>(
      (v, k) => (v as Record<string, unknown> | undefined)?.[k],
      value,
    )
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
        get(name).setState(partial)
        return get(name).getState()
      },
    },
    'store.call': {
      description:
        'Call an action on a store, e.g. ("settings", "setColorScheme", "dark").',
      run: (name: string, action: string, ...args: unknown[]) => {
        const fn = (get(name).getState() as Record<string, unknown>)[action]
        if (typeof fn !== 'function')
          throw new Error(`Store "${name}" has no action "${action}"`)
        return (fn as (...a: unknown[]) => unknown)(...args)
      },
    },
  }
}
