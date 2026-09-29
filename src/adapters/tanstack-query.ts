import { hashKey, type QueryClient, type QueryKey } from '@tanstack/query-core'

import type { Tools } from '../runtime/types'
import { onMockSignal } from '../shared/mock-signal'

type PinState = {
  pins: Map<string, { key: QueryKey; data: unknown }>
  /** Keys the agent overwrote with query.set, by hash, for query.restore. */
  changed: Map<string, QueryKey>
  seeded: WeakSet<object>
  applying: boolean
  unsubscribe: (() => void) | null
  /** Queries that fetched while an agent mock answered, by hash, with the mock ids. */
  mocked: Map<string, Set<string>>
  /** Fetches under way, by hash, with the agent mock ids that answered meanwhile. */
  inflight: Map<string, Set<string>>
  /** Mocked queries cleared since query.restore last reported. */
  clearedSince: number
  tracking: boolean
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
      mocked: new Map(),
      inflight: new Map(),
      clearedSince: 0,
      tracking: false,
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
 * A query key from a tool's arguments: `("todos", 1)` or `(["todos", 1])`,
 * since the CLI spreads a JSON array into arguments.
 */
const keyOf = (args: unknown[]): QueryKey =>
  args.length === 1 && Array.isArray(args[0]) ? args[0] : args

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

  // Looks a hash up without adding an empty query for a key that isn't cached.
  const existingHash = (key: QueryKey) =>
    cache.find({ queryKey: key, exact: true })?.queryHash ?? hashKey(key)

  // query.set and query.pin take (key, data), so a flat key can't be told
  // from the data: ["todos", {...}] would seed the string key "todos".
  const arrayKey = (tool: string, key: unknown): QueryKey => {
    if (!Array.isArray(key))
      throw new Error(
        `${tool} takes the key as an array, got ${JSON.stringify(key)}. Wrap it: [[${JSON.stringify(key)}], <data>]`,
      )
    return key
  }

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

  const unpinKey = (key: QueryKey, hash = existingHash(key)) => {
    const removed = pins.delete(hash)
    if (!pins.size) {
      state.unsubscribe?.()
      state.unsubscribe = null
    }
    if (removed)
      void queryClient.invalidateQueries({ queryKey: key, exact: true })
    return removed
  }
  const unpin = (...args: unknown[]) => unpinKey(keyOf(args))

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

  // Queries whose fetch succeeded while an agent mock answered a request are
  // marked, because a failing real refetch would keep their fake data. The
  // network module only tells us (mock-signal) that a mock answered; which
  // request it was isn't known, so any answer during a fetch marks it.
  const track = () => {
    if (state.tracking) return
    state.tracking = true
    cache.subscribe((event) => {
      if (event.type !== 'updated') return
      const hash = event.query.queryHash
      const { type } = event.action
      if (type === 'fetch') {
        if (!state.inflight.has(hash)) state.inflight.set(hash, new Set())
      } else if (type === 'success') {
        const ids = state.inflight.get(hash)
        state.inflight.delete(hash)
        if (ids?.size) state.mocked.set(hash, ids)
        else if (ids) state.mocked.delete(hash)
      } else if (event.query.state.fetchStatus !== 'fetching') {
        state.inflight.delete(hash)
      }
    })
    onMockSignal({
      answered: (id) => {
        for (const ids of state.inflight.values()) ids.add(id)
      },
      removed: (ids) => clearMocked(ids),
    })
  }

  // Reset, not invalidate: the real fetch may fail, and React Query would keep
  // the previous (fake) data. Queries with observers refetch after the reset.
  const clearMocked = (ids?: string[]) => {
    let cleared = 0
    for (const [hash, from] of [...state.mocked]) {
      if (ids && !ids.some((id) => from.has(id))) continue
      state.mocked.delete(hash)
      const query = cache.get(hash)
      if (!query) continue
      cleared += 1
      queryClient.resetQueries({ queryKey: query.queryKey, exact: true }).catch(() => {})
    }
    state.clearedSince += cleared
    return cleared
  }
  track()

  return {
    'query.list': {
      description:
        'Cached queries: key, status, fetchStatus, observer count, pinned, isStale, isInvalidated, dataUpdatedAt, errorUpdatedAt. Optional key prefix filter, e.g. ("todos") or (["todos", 1]).',
      run: (...args: unknown[]) =>
        cache.findAll(args.length ? { queryKey: keyOf(args) } : {}).map((q) => ({
          key: q.queryKey,
          status: q.state.status,
          fetchStatus: q.state.fetchStatus,
          observers: q.getObserversCount(),
          pinned: pins.has(q.queryHash),
          isStale: q.isStale(),
          isInvalidated: q.state.isInvalidated,
          dataUpdatedAt: q.state.dataUpdatedAt,
          errorUpdatedAt: q.state.errorUpdatedAt,
        })),
    },
    'query.get': {
      description:
        'Cached data for a query key, e.g. ("todos", 1) or (["todos", 1]). Errors when no such query is cached, listing keys that start the same.',
      run: (...args: unknown[]) => {
        const key = keyOf(args)
        if (!key.length) throw new Error('query.get needs a query key')
        if (!cache.find({ queryKey: key, exact: true })) {
          const near = cache
            .findAll({ queryKey: key.slice(0, 1) })
            .slice(0, 5)
            .map((q) => JSON.stringify(q.queryKey))
          throw new Error(
            `No cached query with key ${JSON.stringify(key)}.${near.length ? ` Similar: ${near.join(', ')}` : ' See query.list.'}`,
          )
        }
        return queryClient.getQueryData(key)
      },
    },
    'query.set': {
      maxArgs: 2,
      description:
        'Replace cached data once. A refetch will overwrite it; use query.pin to keep it.',
      run: async (given: unknown, data: unknown) => {
        const key = arrayKey('query.set', given)
        const hash = hashOf(key)
        if (!state.changed.has(hash)) state.changed.set(hash, key)
        queryClient.setQueryData(key, data)
        await rendered()
        return queryClient.getQueryData(key)
      },
    },
    'query.pin': {
      maxArgs: 2,
      description:
        'Seed data for a query key and keep it through refetches until unpinned.',
      run: async (given: unknown, data: unknown) => {
        const key = arrayKey('query.pin', given)
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
      maxArgs: 0,
      description: 'Stop every pin and refetch real data.',
      run: () =>
        [...pins].filter(([hash, { key }]) => unpinKey(key, hash)).length,
    },
    'query.refetch': {
      description:
        'Refetch the queries matching a key prefix, e.g. ("todos", 1) or (["todos", 1]). Returns { matched, refetched, data } (data of the exact key); errors when none match or none can be refetched (disabled, or no queryFn).',
      run: async (...args: unknown[]) => {
        const key = keyOf(args)
        const found = cache.findAll({ queryKey: key })
        if (!found.length)
          throw new Error(
            `No cached query matches key ${JSON.stringify(key)}. See query.list.`,
          )
        const defaultFn = queryClient.getDefaultOptions().queries?.queryFn
        const refetched = found.filter(
          (q) => !q.isDisabled() && (q.options.queryFn ?? defaultFn),
        ).length
        if (!refetched)
          throw new Error(
            `${found.length} cached ${found.length === 1 ? 'query matches' : 'queries match'} key ${JSON.stringify(key)}, but none can be refetched (disabled, or no queryFn).`,
          )
        await queryClient.refetchQueries({ queryKey: key })
        await rendered()
        return {
          matched: found.length,
          refetched,
          data: queryClient.getQueryData(key),
        }
      },
    },
    'query.restore': {
      maxArgs: 0,
      pending: () => pins.size > 0 || state.changed.size > 0 || state.mocked.size > 0,
      description:
        'Undo the agent: unpin everything, refetch real data for keys changed with query.set, and reset queries that fetched while a net.mock answered (net.unmock and net.restore do this too). Returns { unpinned, refetched, mockedCleared }.',
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
        clearMocked()
        const mockedCleared = state.clearedSince
        state.clearedSince = 0
        await rendered()
        return { unpinned: unpinned.length, refetched, mockedCleared }
      },
    },
    'query.invalidate': {
      description: 'Invalidate queries matching a key prefix, e.g. ("todos") or (["todos"]).',
      run: (...args: unknown[]) =>
        queryClient.invalidateQueries({ queryKey: keyOf(args) }),
    },
  }
}
