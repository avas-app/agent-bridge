import { hashKey, type QueryClient, type QueryKey } from '@tanstack/query-core'

import type { Tools } from '../runtime/types'
import { trackMockedQueries } from './query-mocked'

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
 * A query key from a tool's arguments: `("todos", 1)` or `(["todos", 1])`,
 * since the CLI spreads a JSON array into arguments.
 */
const keyOf = (args: unknown[]): QueryKey =>
  args.length === 1 && Array.isArray(args[0]) ? args[0] : args

type GetOptions = { pages?: unknown; path?: unknown }

/** A trailing `{ pages }` / `{ path }` on query.get, as opposed to an object key part. */
const isGetOptions = (v: unknown): v is GetOptions =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length > 0 &&
  Object.keys(v).every((k) => k === 'pages' || k === 'path')

/** An infinite query's pages [from, to), like Array.slice, with the total. */
function slicePages(data: unknown, range: unknown): unknown {
  const infinite = data as { pages?: unknown; pageParams?: unknown } | undefined
  if (!infinite || !Array.isArray(infinite.pages))
    throw new Error('pages only applies to an infinite query (data with a pages array)')
  const [from, to] = Array.isArray(range) ? range : [range]
  if (
    typeof from !== 'number' ||
    (to !== undefined && typeof to !== 'number')
  )
    throw new Error(
      `pages is [from, to] (to exclusive, like Array.slice) or a start index, got ${JSON.stringify(range)}`,
    )
  return {
    ...infinite,
    pages: infinite.pages.slice(from, to),
    ...(Array.isArray(infinite.pageParams) && {
      pageParams: infinite.pageParams.slice(from, to),
    }),
    totalPages: infinite.pages.length,
  }
}

/** The value at a dotted path ("pages.0.items") or array of segments; errors name the step that is missing. */
function atPath(value: unknown, path: unknown): unknown {
  const segments =
    typeof path === 'string'
      ? path.split('.').filter(Boolean)
      : Array.isArray(path) &&
          path.every((p) => typeof p === 'string' || typeof p === 'number')
        ? path
        : null
  if (!segments)
    throw new Error(
      `path is a dotted string or an array of segments, got ${JSON.stringify(path)}`,
    )
  let current = value
  segments.forEach((segment, i) => {
    if (
      current === null ||
      typeof current !== 'object' ||
      !(String(segment) in current)
    ) {
      const where = segments.slice(0, i).join('.') || 'the data'
      const has =
        current && typeof current === 'object'
          ? Array.isArray(current)
            ? `an array of ${current.length}`
            : `keys ${Object.keys(current).slice(0, 10).join(', ') || '(none)'}`
          : JSON.stringify(current) ?? 'undefined'
      throw new Error(`No "${segment}" in ${where}: it has ${has}`)
    }
    current = (current as Record<string, unknown>)[segment as string]
  })
  return current
}

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

  const mocked = trackMockedQueries(queryClient, (hash) => pins.has(hash))

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
        'Cached data for a query key, e.g. ("todos", 1) or (["todos", 1]). Errors when no such query is cached, listing keys that start the same. For a big one, a last { pages: [from, to] } returns only those pages of an infinite query (to exclusive, like Array.slice; adds totalPages), and { path: "pages.0.items" } returns only the value there (after pages, if both).',
      run: (...args: unknown[]) => {
        // A trailing object is options only if the key with it isn't cached,
        // since objects are valid key parts too.
        const last = args[args.length - 1]
        const options =
          args.length > 1 &&
          isGetOptions(last) &&
          !cache.find({ queryKey: keyOf(args), exact: true })
            ? last
            : undefined
        const key = keyOf(options ? args.slice(0, -1) : args)
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
        let data = queryClient.getQueryData(key)
        if (options?.pages !== undefined) data = slicePages(data, options.pages)
        if (options?.path !== undefined) data = atPath(data, options.path)
        return data
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
      pending: () => pins.size > 0 || state.changed.size > 0 || mocked.pending(),
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
        mocked.clear()
        const mockedCleared = mocked.takeCleared()
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
