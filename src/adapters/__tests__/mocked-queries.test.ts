import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryObserver } from '@tanstack/query-core'

import { networkTools } from '../../network'
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
    const stop = observer.subscribe(() => {})
    await observer.refetch()
    expect(observer.getCurrentResult().data).toEqual({ fake: true })

    run(tools, 'net.restore')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(observer.getCurrentResult().data).toEqual({ real: `${API}/plants` })
    stop()
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
