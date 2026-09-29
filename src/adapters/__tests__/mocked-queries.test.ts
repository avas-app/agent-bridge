import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { InfiniteQueryObserver, onlineManager, QueryClient, QueryObserver } from '@tanstack/query-core'

import { networkTools } from '../../network'
import { mockSignalListeners } from '../../shared/mock-signal'
import { resetNetworkState } from '../../network/state'
import { nativeFetch, server } from '../../network/__tests__/fakes'
import { restoreTools } from '../../runtime/tools/restore'
import type { ToolFn, Tools } from '../../runtime/types'
import { queryTools } from '../tanstack-query'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

const g = globalThis as unknown as Record<string, unknown>
const saved = { fetch: g.fetch }
const API = 'https://api.sprout.example'

let client: QueryClient
let tools: Tools

const load = (key: string) =>
  client
    .fetchQuery({
      queryKey: [key],
      staleTime: 0,
      retry: false,
      queryFn: async () => {
        const res = await fetch(`${API}/${key}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      },
    })
    .catch(() => undefined)

const data = (key: string) => client.getQueryData<unknown>([key])

beforeEach(() => {
  g.fetch = nativeFetch
  server.hits = []
  server.handle = (_m, url) => ({ status: 200, body: JSON.stringify({ real: url }) })
  client = new QueryClient()
  tools = { ...networkTools(), ...queryTools(client) }
})

afterEach(() => {
  resetNetworkState()
  Object.assign(g, saved)
})

const failRealEndpoint = () => {
  server.handle = () => ({ status: 404, body: '{}' })
}

describe('data that came from a mock', () => {
  for (const undo of ['net.unmock', 'net.restore'] as const) {
    test(`is gone after ${undo}, even when the real endpoint then fails`, async () => {
      run(tools, 'net.mock', '/plants', { json: { fake: true } })
      await load('plants')
      expect(data('plants')).toEqual({ fake: true })

      run(tools, undo)
      failRealEndpoint()
      await client.refetchQueries({ queryKey: ['plants'] })
      expect(data('plants')).toBeUndefined()
    })
  }

  test('is reset while a screen observes it, then refetched for real', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    const observer = new QueryObserver(client, {
      queryKey: ['plants'],
      retry: false,
      queryFn: async () => (await fetch(`${API}/plants`)).json(),
    })
    const real = { real: `${API}/plants` }
    const refetched = new Promise<void>((resolve) => {
      const stop = observer.subscribe((result) => {
        if (JSON.stringify(result.data) === JSON.stringify(real)) {
          stop()
          resolve()
        }
      })
    })
    await observer.refetch()
    expect(observer.getCurrentResult().data).toEqual({ fake: true })

    run(tools, 'net.restore')
    await refetched
  })

  test('leaves queries no mock touched alone', async () => {
    await load('user')
    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    await load('plants')
    await load('user')
    run(tools, 'net.restore')
    failRealEndpoint()
    await load('plants')

    expect(data('user')).toEqual({ real: `${API}/user` })
    expect(data('plants')).toBeUndefined()
  })

  test('is kept once a real fetch has replaced it', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } }, { times: 1 })
    await load('plants')
    await new Promise((resolve) => setTimeout(resolve, 5)) // past staleTime 0
    await load('plants')
    expect(data('plants')).toEqual({ real: `${API}/plants` })

    run(tools, 'net.restore')
    expect(data('plants')).toEqual({ real: `${API}/plants` })
  })

  test('net.unmock with an id resets only what that mock answered', async () => {
    const a = run(tools, 'net.mock', '/plants', { json: { fake: 'a' } }) as { id: string }
    run(tools, 'net.mock', '/user', { json: { fake: 'b' } })
    await load('plants')
    await load('user')

    run(tools, 'net.unmock', a.id)
    expect(data('plants')).toBeUndefined()
    expect(data('user')).toEqual({ fake: 'b' })
  })

  test('app mocks are not agent mocks: their data stays', async () => {
    const { mock } = await import('../../network')
    mock('/plants', { json: { fake: 'app' } })
    await load('plants')
    run(tools, 'net.restore')
    expect(data('plants')).toEqual({ fake: 'app' })
  })
})

describe('attribution', () => {
  test('a real request in parallel with a mocked one is left alone', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    await Promise.all([load('plants'), load('user')])
    run(tools, 'net.restore')
    expect(data('plants')).toBeUndefined()
    expect(data('user')).toEqual({ real: `${API}/user` })
    expect(await run(tools, 'query.restore')).toMatchObject({ mockedCleared: 1 })
  })

  // An async interceptor (axios auth token) starts every request after a tick.
  const late = (key: string, options: object = {}) =>
    client
      .fetchQuery({
        queryKey: [key],
        retry: false,
        queryFn: async () => {
          await Promise.resolve()
          return (await fetch(`${API}/${key}`)).json()
        },
        ...options,
      })
      .catch(() => undefined)

  test('a query function that awaits before requesting is still caught', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    await late('plants')
    expect(data('plants')).toEqual({ fake: true })
    run(tools, 'net.restore')
    expect(data('plants')).toBeUndefined()
  })

  test('behind an async interceptor, a real query fetching in parallel is reset too', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    await Promise.all([late('plants'), late('user')])
    run(tools, 'net.restore')
    expect(data('plants')).toBeUndefined()
    // The trade-off: attribution can't tell them apart, so the real one goes as well.
    expect(data('user')).toBeUndefined()
  })

  test('a request after an await in a query function is attributed', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    await client
      .fetchQuery({
        queryKey: ['plants'],
        queryFn: async () => {
          await fetch(`${API}/me`)
          return (await fetch(`${API}/plants`)).json()
        },
      })
      .catch(() => undefined)
    expect(data('plants')).toEqual({ fake: true })
    run(tools, 'net.restore')
    expect(data('plants')).toBeUndefined()
  })

  test('a retry that lands on the mock is attributed', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    let attempts = 0
    await client.fetchQuery({
      queryKey: ['plants'],
      retry: 1,
      retryDelay: 1,
      queryFn: async () => {
        if (attempts++ === 0) throw new Error('first try fails')
        return (await fetch(`${API}/plants`)).json()
      },
    })
    expect(data('plants')).toEqual({ fake: true })
    run(tools, 'net.restore')
    expect(data('plants')).toBeUndefined()
  })

  test('a fetch that paused (offline) is still marked when it succeeds', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    client.mount() // resumes paused fetches when back online
    onlineManager.setOnline(false)
    try {
      const loading = load('plants')
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(client.getQueryCache().find({ queryKey: ['plants'] })?.state.fetchStatus).toBe('paused')
      onlineManager.setOnline(true)
      await loading
    } finally {
      onlineManager.setOnline(true)
      client.unmount()
    }
    expect(data('plants')).toEqual({ fake: true })
    run(tools, 'net.restore')
    expect(data('plants')).toBeUndefined()
  })

  test('setQueryData is not a fetch: it drops the mark, and mid-fetch leaves it', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    await load('plants')
    client.setQueryData(['plants'], { app: 'wrote this' })
    run(tools, 'net.restore')
    expect(data('plants')).toEqual({ app: 'wrote this' })
  })

  test('an infinite query keeps no fake page when a later page came from the network', async () => {
    run(tools, 'net.mock', '/pages', { json: { page: 'fake' } }, { times: 1 })
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['pages'],
      retry: false,
      initialPageParam: 1,
      getNextPageParam: (_l: unknown, all: unknown[]) => all.length + 1,
      queryFn: async ({ pageParam }: { pageParam: number }) =>
        (await fetch(`${API}/pages?page=${pageParam}`)).json(),
    })
    const stop = observer.subscribe(() => {})
    await observer.refetch()
    await observer.fetchNextPage()
    stop()
    expect(JSON.stringify(data('pages'))).toContain('fake')

    failRealEndpoint()
    run(tools, 'net.restore')
    expect(data('pages')).toBeUndefined()
  })

  test('a full refetch of an infinite query keeps its mark', async () => {
    run(tools, 'net.mock', '/pages', { json: { page: 'fake' } }, { times: 1 })
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['pages'],
      retry: false,
      initialPageParam: 1,
      getNextPageParam: (_l: unknown, all: unknown[]) => all.length + 1,
      queryFn: async ({ pageParam }: { pageParam: number }) =>
        (await fetch(`${API}/pages?page=${pageParam}`)).json(),
    })
    const stop = observer.subscribe(() => {})
    await observer.refetch()
    await observer.fetchNextPage()
    await observer.refetch()
    stop()
    // Conservative: the pages are real now, but a refetch of an infinite query isn't proof.
    failRealEndpoint()
    run(tools, 'net.restore')
    expect(await run(tools, 'query.restore')).toMatchObject({ mockedCleared: 1 })
  })

  test('a response that lands after the mock was removed is cleared on arrival', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } }, { delayMs: 20 })
    const loading = load('plants')
    await new Promise((resolve) => setTimeout(resolve, 5))
    run(tools, 'net.restore')
    await loading
    await Promise.resolve()
    expect(data('plants')).toBeUndefined()
    expect(await run(tools, 'query.restore')).toMatchObject({ mockedCleared: 1 })
  })

  test('a pinned key is not reset', async () => {
    await run(tools, 'query.pin', ['plants'], { pinned: true })
    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    await load('plants')
    run(tools, 'net.restore')
    expect(data('plants')).toEqual({ pinned: true })
    const { mockedCleared } = (await run(tools, 'query.restore')) as { mockedCleared: number }
    expect(mockedCleared).toBe(0)
  })

  test('each client tracks its own queries, and rebuilding tools adds no listener', async () => {
    const other = new QueryClient()
    const otherTools = queryTools(other)
    const listeners = mockSignalListeners()
    for (let i = 0; i < 5; i++) queryTools(client)
    expect(mockSignalListeners()).toBe(listeners)

    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    await load('plants')
    await other
      .fetchQuery({ queryKey: ['plants'], queryFn: async () => (await fetch(`${API}/plants`)).json() })
    run(tools, 'net.restore')
    expect(data('plants')).toBeUndefined()
    expect(other.getQueryData(['plants'])).toBeUndefined()
    expect(await run(otherTools, 'query.restore')).toMatchObject({ mockedCleared: 1 })
  })
})

describe('bridge.restore', () => {
  const bridge = () => restoreTools(() => tools)

  test('clears mocked queries and reports how many, in either order', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    await load('plants')
    failRealEndpoint()

    const results = (await run(bridge(), 'bridge.restore')) as Record<string, unknown>
    expect(results['query.restore']).toMatchObject({ mockedCleared: 1 })
    expect(data('plants')).toBeUndefined()
  })

  test('query.restore alone clears them while the mock is still on', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    await load('plants')
    const { pending } = tools['query.restore'] as { pending: () => boolean }
    expect(pending()).toBe(true)

    expect(await run(tools, 'query.restore')).toMatchObject({ mockedCleared: 1 })
    expect(data('plants')).toBeUndefined()
    expect(pending()).toBe(false)
  })

  test('after a times mock expired, still clears it', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } }, { times: 1 })
    await load('plants')
    failRealEndpoint()
    const results = (await run(bridge(), 'bridge.restore')) as Record<string, unknown>
    expect(results['query.restore']).toMatchObject({ mockedCleared: 1 })
    expect(data('plants')).toBeUndefined()
  })

  test('net.restore first still shows in the query.restore report', async () => {
    run(tools, 'net.mock', '/plants', { json: { fake: true } })
    await load('plants')
    run(tools, 'net.restore')
    expect(await run(tools, 'query.restore')).toMatchObject({ mockedCleared: 1 })
    expect(await run(tools, 'query.restore')).toMatchObject({ mockedCleared: 0 })
  })
})

test('the query adapter works without the network module', async () => {
  const solo = new QueryClient()
  const soloTools = queryTools(solo)
  await solo.fetchQuery({ queryKey: ['a'], queryFn: async () => 1 })
  expect(await run(soloTools, 'query.restore')).toMatchObject({ mockedCleared: 0 })
  expect(solo.getQueryData<number>(['a'])).toBe(1)
})
