import type { Query, QueryClient } from '@tanstack/query-core'

import { onMockSignal } from '../shared/mock-signal'

/** A fetch under way: which network requests it started and which a mock answered. */
type Fetch = {
  /** Requests started while query.fetch ran synchronously, i.e. the query function's own. */
  own: Set<number>
  /** Agent mocks that answered one of `own`. */
  ids: Set<string>
  /** Agent mocks that answered a request no fetch owns (started after an await, a retry). */
  loose: Set<string>
  fetchMore: boolean
  /** Its mock was removed before the fetch finished. */
  gone: boolean
}

export type MockedQueries = {
  /** Resets the marked queries a mock in `ids` (any when undefined) answered. */
  clear: (ids?: string[]) => number
  pending: () => boolean
  /** Queries reset since the last call. */
  takeCleared: () => number
}

type Tracker = MockedQueries & { isPinned: (hash: string) => boolean }

// On globalThis, like mock-signal, so a second copy of this module (ESM and CJS)
// shares the one tracker instead of wrapping and resetting the same queries twice.
const KEY = Symbol.for('@avasapp/agent-bridge/query-mocked')
const trackers = ((globalThis as unknown as Record<symbol, WeakMap<QueryClient, Tracker>>)[KEY] ??=
  new WeakMap())

// queryType is a getter from query-core 5.10x on; before, an infinite query set options.behavior.
const isInfinite = (query: Query) =>
  (query as unknown as { queryType?: string }).queryType === 'infinite' ||
  !!(query.options as { behavior?: unknown }).behavior

/**
 * Follows which queries hold data an agent mock produced, so restore can reset
 * them: a failing real refetch would otherwise keep the fake data. One tracker
 * per client, whatever the number of times tools are rebuilt.
 *
 * Attribution is per request: the network layer (through mock-signal, so this
 * file never imports it) numbers each request and says which a mock answered,
 * and a query owns the requests its queryFn starts synchronously. A mock
 * answer to a request no fetch owns (started after an await, e.g. behind an
 * async interceptor, or a retry) counts against every fetch in flight.
 */
export function trackMockedQueries(
  queryClient: QueryClient,
  isPinned: (hash: string) => boolean,
): MockedQueries {
  const existing = trackers.get(queryClient)
  if (existing) {
    existing.isPinned = isPinned
    return existing
  }

  const cache = queryClient.getQueryCache()
  /** Marked queries, by hash, with the mock ids that answered them. */
  const mocked = new Map<string, Set<string>>()
  const inflight = new Map<string, Fetch>()
  const instrumented = new WeakSet<Query>()
  const holder: { current: Fetch | null } = { current: null }
  let cleared = 0

  const newFetch = (): Fetch => ({
    own: new Set(),
    ids: new Set(),
    loose: new Set(),
    fetchMore: false,
    gone: false,
  })

  // Reset, not invalidate: the real fetch may fail, and React Query would keep
  // the previous (fake) data. Queries with observers refetch after the reset.
  const reset = (hash: string) => {
    const query = cache.get(hash)
    if (!query || tracker.isPinned(hash)) return
    cleared += 1
    queryClient.resetQueries({ queryKey: query.queryKey, exact: true }).catch(() => {})
  }

  // query.fetch runs the queryFn synchronously, so requests started inside it
  // are the query's.
  const instrument = (query: Query) => {
    if (instrumented.has(query)) return
    instrumented.add(query)
    const original = query.fetch.bind(query)
    query.fetch = ((...args: Parameters<Query['fetch']>) => {
      let f = inflight.get(query.queryHash)
      if (!f) inflight.set(query.queryHash, (f = newFetch()))
      const outer = holder.current
      holder.current = f
      try {
        return original(...args)
      } finally {
        holder.current = outer
      }
    }) as Query['fetch']
  }
  for (const query of cache.getAll()) instrument(query)
  const build = cache.build.bind(cache)
  cache.build = ((...args: Parameters<typeof build>) => {
    const query = build(...args)
    instrument(query as Query)
    return query
  }) as typeof build

  cache.subscribe((event) => {
    if (event.type !== 'updated') return
    const { query, action } = event
    const hash = query.queryHash
    if (action.type === 'fetch') {
      let f = inflight.get(hash)
      if (!f) inflight.set(hash, (f = newFetch()))
      if ((action as { meta?: { fetchMore?: unknown } }).meta?.fetchMore) f.fetchMore = true
    } else if (action.type === 'success') {
      // setQueryData: not a fetch. It replaces the data, so drops the mark.
      if ((action as { manual?: boolean }).manual) {
        if (!inflight.has(hash)) mocked.delete(hash)
        return
      }
      const f = inflight.get(hash)
      inflight.delete(hash)
      if (!f) return
      const used = answeredBy(f)
      const before = mocked.get(hash)
      if (used.size) {
        // Its mock was removed while the response was on its way.
        if (f.gone) {
          mocked.delete(hash)
          reset(hash)
        } else mocked.set(hash, new Set([...(before ?? []), ...used]))
      } else if (before && !f.fetchMore && !isInfinite(query)) {
        // A real fetch replaced the data. Not for an infinite query: a fetch
        // of one page (or a refetch) leaves the other pages, mocked ones too.
        mocked.delete(hash)
      }
    } else if (query.state.fetchStatus === 'idle') {
      // Not 'paused': a fetch waiting to go online still ends in a success.
      inflight.delete(hash)
    }
  })

  const tracker: Tracker = {
    isPinned,
    pending: () => mocked.size > 0,
    takeCleared: () => {
      const n = cleared
      cleared = 0
      return n
    },
    clear: (ids) => {
      const before = cleared
      for (const [hash, from] of [...mocked]) {
        if (ids && !ids.some((id) => from.has(id))) continue
        mocked.delete(hash)
        reset(hash)
      }
      return cleared - before
    },
  }
  trackers.set(queryClient, tracker)

  // The signal's listener list is global; hold the tracker weakly so a replaced
  // client (Fast Refresh) isn't kept alive, and drop the listener once it's gone.
  listen(new WeakRef(tracker), inflight, holder)
  return tracker
}

const answeredBy = (f: Fetch) => new Set([...f.ids, ...f.loose])

// Module level on purpose: closures made inside trackMockedQueries share a
// scope that holds the client, and this listener must not keep it alive.
function listen(
  ref: WeakRef<MockedQueries>,
  inflight: Map<string, Fetch>,
  holder: { current: Fetch | null },
): void {
  const stop = onMockSignal({
    started: (requestId) => {
      if (!ref.deref()) return stop()
      holder.current?.own.add(requestId)
    },
    answered: (mockId, requestId) => {
      if (!ref.deref()) return stop()
      const owner = [...inflight.values()].find((f) => f.own.has(requestId))
      if (owner) owner.ids.add(mockId)
      else for (const f of inflight.values()) f.loose.add(mockId)
    },
    removed: (ids) => {
      const tracker = ref.deref()
      if (!tracker) return stop()
      for (const f of inflight.values())
        if (!ids || [...answeredBy(f)].some((id) => ids.includes(id))) f.gone = true
      tracker.clear(ids)
    },
  })
}
