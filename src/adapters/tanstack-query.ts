import type { QueryClient, QueryKey } from '@tanstack/query-core'

import type { Tools } from '../runtime/types'

type PinState = {
  pins: Map<string, { key: QueryKey; data: unknown }>
  /** Keys the agent overwrote with query.set, by hash, for query.restore. */
  changed: Map<string, QueryKey>
  seeded: WeakSet<object>
  applying: boolean
  unsubscribe: (() => void) | null
}

// Per client, so tools rebuilt on every render still see the same pins.
const pinStates = new WeakMap<QueryClient, PinState>()

function pinStateFor(queryClient: QueryClient): PinState {
  let state = pinStates.get(queryClient)
  if (!state) {
    state = {
      pins: new Map(),
      changed: new Map(),
      seeded: new WeakSet(),
      applying: false,
      unsubscribe: null,
    }
    pinStates.set(queryClient, state)
  }
  return state
}

// TanStack Query tells observers about a change on its scheduler, a
// setTimeout(0) by default, so nothing has rendered it when setQueryData
// returns. Waiting one timeout lets the next call (a screen check) see it.
const rendered = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Read and seed the TanStack Query cache. `query.pin` keeps a seed in place:
 * when a refetch lands with real data, the seed is put back until unpinned.
 */
export function queryTools(queryClient: QueryClient): Tools {
  const cache = queryClient.getQueryCache()
  const state = pinStateFor(queryClient)
  const { pins, seeded } = state

  const hashOf = (key: QueryKey) =>
    cache.build(queryClient, { queryKey: key }).queryHash

  const apply = (key: QueryKey, data: unknown) => {
    state.applying = true
    try {
      queryClient.setQueryData(key, data)
    } finally {
      state.applying = false
    }
    const stored = queryClient.getQueryData(key)
    if (stored && typeof stored === 'object') seeded.add(stored)
  }

  const watch = () => {
    state.unsubscribe ??= cache.subscribe((event) => {
      if (state.applying || event.type !== 'updated') return
      const pin = pins.get(event.query.queryHash)
      const data = event.query.state.data
      if (!pin || (data && typeof data === 'object' && seeded.has(data))) return
      apply(pin.key, pin.data)
    })
  }

  const unpin = (key: QueryKey) => {
    const removed = pins.delete(hashOf(key))
    if (!pins.size) {
      state.unsubscribe?.()
      state.unsubscribe = null
    }
    if (removed)
      void queryClient.invalidateQueries({ queryKey: key, exact: true })
    return removed
  }

  // Put a query the agent touched back to real data: refetch it (active or
  // not), or drop it when it has nothing to fetch with, since only the agent
  // put it there.
  const refetchReal = (key: QueryKey) => {
    const query = cache.find({ queryKey: key, exact: true })
    if (!query) return false
    const queryFn =
      query.options.queryFn ?? queryClient.getDefaultOptions().queries?.queryFn
    if (!queryFn) {
      cache.remove(query)
      return false
    }
    void queryClient.invalidateQueries({
      queryKey: key,
      exact: true,
      refetchType: 'all',
    })
    return true
  }

  return {
    'query.list': {
      description: 'Cached queries: key, status, observer count, pinned.',
      run: () =>
        cache.getAll().map((q) => ({
          key: q.queryKey,
          status: q.state.status,
          observers: q.getObserversCount(),
          pinned: pins.has(q.queryHash),
        })),
    },
    'query.get': {
      description: 'Cached data for a query key.',
      run: (key: QueryKey) => queryClient.getQueryData(key),
    },
    'query.set': {
      description:
        'Replace cached data once. A refetch will overwrite it; use query.pin to keep it.',
      run: async (key: QueryKey, data: unknown) => {
        const hash = hashOf(key)
        if (!state.changed.has(hash)) state.changed.set(hash, key)
        queryClient.setQueryData(key, data)
        await rendered()
        return queryClient.getQueryData(key)
      },
    },
    'query.pin': {
      description:
        'Seed data for a query key and keep it through refetches until unpinned.',
      run: async (key: QueryKey, data: unknown) => {
        pins.set(hashOf(key), { key, data })
        watch()
        apply(key, data)
        await rendered()
        return queryClient.getQueryData(key)
      },
    },
    'query.unpin': {
      description: 'Stop pinning a key and refetch its real data.',
      run: unpin,
    },
    'query.unpinAll': {
      description: 'Stop every pin and refetch real data.',
      run: () =>
        [...pins.values()].map((p) => p.key).filter((key) => unpin(key)).length,
    },
    'query.refetch': {
      description: 'Refetch a query and return its data.',
      run: async (key: QueryKey) => {
        await queryClient.refetchQueries({ queryKey: key })
        await rendered()
        return queryClient.getQueryData(key)
      },
    },
    'query.restore': {
      description:
        'Undo the agent: unpin everything and refetch real data for keys changed with query.set.',
      run: async () => {
        const unpinned = [...pins.values()].map((p) => p.key)
        const changed = [...state.changed]
          .filter(([hash]) => !pins.has(hash))
          .map(([, key]) => key)
        pins.clear()
        state.changed.clear()
        state.unsubscribe?.()
        state.unsubscribe = null
        for (const key of unpinned) refetchReal(key)
        const refetched = changed.filter((key) => refetchReal(key)).length
        await rendered()
        return { unpinned: unpinned.length, refetched }
      },
    },
    'query.invalidate': {
      description: 'Invalidate queries matching a key prefix.',
      run: (key: QueryKey) => queryClient.invalidateQueries({ queryKey: key }),
    },
  }
}
