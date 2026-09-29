import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryObserver } from '@tanstack/query-core'

import { createRegistry } from '../../runtime/registry'
import type { ToolFn, Tools } from '../../runtime/types'
import { queryTools } from '../tanstack-query'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

describe('queryTools', () => {
  test('a pin survives a refetch and unpin restores real data', async () => {
    const client = new QueryClient()
    const tools = queryTools(client)
    let real = 'real-1'
    const fetchFlags = () => client.fetchQuery({ queryKey: ['flags'], queryFn: async () => real, staleTime: 0 })

    await fetchFlags()
    expect(client.getQueryData<unknown>(['flags'])).toBe('real-1')

    run(tools, 'query.pin', ['flags'], { wallet: false })
    real = 'real-2'
    await fetchFlags()
    expect(client.getQueryData<unknown>(['flags'])).toEqual({ wallet: false })

    expect(run(tools, 'query.unpin', ['flags'])).toBe(true)
    await fetchFlags()
    expect(client.getQueryData<unknown>(['flags'])).toBe('real-2')
  })

  test('lists queries with their pinned state', async () => {
    const client = new QueryClient()
    const tools = queryTools(client)
    client.setQueryData(['user'], { name: 'x' })
    run(tools, 'query.pin', ['inbox'], [])
    const list = run(tools, 'query.list') as Array<{ key: unknown; pinned: boolean }>
    expect(list.find((q) => JSON.stringify(q.key) === '["inbox"]')?.pinned).toBe(true)
    expect(list.find((q) => JSON.stringify(q.key) === '["user"]')?.pinned).toBe(false)
    expect(run(tools, 'query.unpinAll')).toBe(1)
  })

  test('pin and set resolve after observers (the screen) have seen the data', async () => {
    const client = new QueryClient()
    const tools = queryTools(client)
    const seen: Record<string, unknown> = {}
    const observe = (name: string) =>
      new QueryObserver(client, { queryKey: [name], enabled: false }).subscribe((result) => {
        seen[name] = result.data
      })
    const stops = [observe('flags'), observe('user')]

    await run(tools, 'query.pin', ['flags'], { wallet: false })
    expect(seen.flags).toEqual({ wallet: false })
    await run(tools, 'query.set', ['user'], { name: 'x' })
    expect(seen.user).toEqual({ name: 'x' })
    for (const stop of stops) stop()
    run(tools, 'query.unpinAll')
  })

  test('tools rebuilt on a re-render share pins with the old ones', async () => {
    const client = new QueryClient()
    let real = 'real-1'
    const fetchFlags = () => client.fetchQuery({ queryKey: ['flags'], queryFn: async () => real, staleTime: 0 })

    run(queryTools(client), 'query.pin', ['flags'], { wallet: false })
    const rebuilt = queryTools(client)
    expect(run(rebuilt, 'query.unpinAll')).toBe(1)

    real = 'real-2'
    await fetchFlags()
    expect(client.getQueryData<unknown>(['flags'])).toBe('real-2')
  })

  test('query.restore unpins, refetches set keys and drops agent-only ones, across rebuilt tools', async () => {
    const client = new QueryClient()
    let fetches = 0
    const observe = (name: string) =>
      new QueryObserver(client, { queryKey: [name], queryFn: async () => `real-${name}-${++fetches}` }).subscribe(
        () => {},
      )
    const stops = [observe('plants'), observe('user')]
    await client.refetchQueries()

    await run(queryTools(client), 'query.pin', ['plants'], ['seeded'])
    await run(queryTools(client), 'query.set', ['user'], { name: 'x' })
    await run(queryTools(client), 'query.set', ['user'], { name: 'y' })
    await run(queryTools(client), 'query.set', ['agentOnly'], 1)

    expect(await run(queryTools(client), 'query.restore')).toEqual({ unpinned: 1, refetched: 1, mockedCleared: 0 })
    await new Promise((r) => setTimeout(r, 10)) // the refetches restore started
    expect(client.getQueryData<string>(['plants'])).toStartWith('real-plants')
    expect(client.getQueryData<string>(['user'])).toStartWith('real-user')
    expect(client.getQueryData(['agentOnly'])).toBeUndefined()
    expect(await run(queryTools(client), 'query.restore')).toEqual({ unpinned: 0, refetched: 0, mockedCleared: 0 })
    for (const stop of stops) stop()
  })

  describe('key shapes', () => {
    const setup = () => {
      const client = new QueryClient()
      client.setQueryData(['expressInfo', 'id'], { a: 1 })
      client.setQueryData(['expressInfo', 'other'], 2)
      client.getQueryCache().build(client, { queryKey: ['todos'] })
      return { client, tools: queryTools(client) }
    }

    test('query.get takes a flat key or a wrapped one', () => {
      const { tools } = setup()
      expect(run(tools, 'query.get', 'expressInfo', 'id')).toEqual({ a: 1 })
      expect(run(tools, 'query.get', ['expressInfo', 'id'])).toEqual({ a: 1 })
    })

    test('query.get errors on a missing query, with similar keys, but not on undefined data', () => {
      const { tools } = setup()
      expect(() => run(tools, 'query.get', 'expressInfo', 'nope')).toThrow(
        'No cached query with key ["expressInfo","nope"]. Similar: ["expressInfo","id"]',
      )
      expect(() => run(tools, 'query.get')).toThrow('needs a query key')
      expect(run(tools, 'query.get', ['todos'])).toBeUndefined()
    })

    test('query.refetch reports how many matched and errors on none', async () => {
      const { client, tools } = setup()
      let n = 0
      const queryFn = async () => ++n
      for (const q of client.getQueryCache().findAll({ queryKey: ['expressInfo'] })) q.setOptions({ queryFn })
      expect(await run(tools, 'query.refetch', 'expressInfo', 'id')).toEqual({ matched: 1, refetched: 1, data: 1 })
      expect(await run(tools, 'query.refetch', ['expressInfo'])).toMatchObject({ matched: 2, refetched: 2 })
      await expect(run(tools, 'query.refetch', 'missing')).rejects.toThrow('No cached query matches key ["missing"]')
    })

    test('query.list shows staleness and timestamps, and filters by prefix in either shape', () => {
      const { client, tools } = setup()
      type Row = { key: unknown[]; isInvalidated: boolean; isStale: boolean; fetchStatus: string; dataUpdatedAt: number; errorUpdatedAt: number }
      const only = (...args: unknown[]) => run(tools, 'query.list', ...args) as Row[]
      expect(only()).toHaveLength(3)
      expect(only('expressInfo').map((q) => q.key)).toEqual([['expressInfo', 'id'], ['expressInfo', 'other']])
      expect(only(['expressInfo', 'id'])).toHaveLength(1)
      const [entry] = only(['expressInfo', 'id'])
      expect(entry).toMatchObject({ isInvalidated: false, fetchStatus: 'idle', errorUpdatedAt: 0 })
      expect(entry!.dataUpdatedAt).toBeGreaterThan(0)
      void client.invalidateQueries({ queryKey: ['expressInfo', 'id'], refetchType: 'none' })
      expect(only(['expressInfo', 'id'])[0]).toMatchObject({ isInvalidated: true, isStale: true })
    })

    test('query.invalidate and query.unpin take a flat key', async () => {
      const { client, tools } = setup()
      await run(tools, 'query.pin', ['flat', 'pin'], 1)
      expect(run(tools, 'query.unpin', 'flat', 'pin')).toBe(true)
      expect(run(tools, 'query.unpin', 'flat', 'pin')).toBe(false)
      await run(tools, 'query.invalidate', 'expressInfo')
      expect(client.getQueryState(['expressInfo', 'id'])?.isInvalidated).toBe(true)
    })

    test('query.unpin of an uncached key does not create an entry', () => {
      const { tools } = setup()
      expect(run(tools, 'query.unpin', 'typo')).toBe(false)
      expect(() => run(tools, 'query.get', 'typo')).toThrow('No cached query')
    })

    test('query.set and query.pin reject a key that is not an array, and extra args', async () => {
      const { client, tools } = setup()
      await expect(run(tools, 'query.set', 'todos', { a: 1 })).rejects.toThrow('takes the key as an array')
      await expect(run(tools, 'query.pin', 'todos', { a: 1 })).rejects.toThrow('Wrap it: [["todos"], <data>]')
      expect(client.getQueryData('todos' as never)).toBeUndefined()
      const registry = createRegistry(() => tools)
      const call = (tool: string, ...args: unknown[]) => registry.dispatch({ id: '1', tool, args }, 'dev')
      expect(await call('query.set', ['x'], 1, 2)).toMatchObject({ ok: false, error: expect.stringContaining('at most 2') })
      expect(await call('query.unpinAll', 1)).toMatchObject({ ok: false })
    })

    test('query.unpinAll unpins every pin, including flat-looking keys', async () => {
      const { tools } = setup()
      await run(tools, 'query.pin', ['p'], 1)
      await run(tools, 'query.pin', ['q', 1], 2)
      expect(run(tools, 'query.unpinAll')).toBe(2)
      expect((run(tools, 'query.list', 'p') as Array<{ pinned: boolean }>)[0]!.pinned).toBe(false)
      expect(run(tools, 'query.unpinAll')).toBe(0)
    })

    test('query.refetch does not count queries it cannot fetch', async () => {
      const { client, tools } = setup()
      // ['todos'] was built with no data and no queryFn.
      await expect(run(tools, 'query.refetch', 'todos')).rejects.toThrow('none can be refetched')
      client.getQueryCache().find({ queryKey: ['expressInfo', 'id'] })!.setOptions({ queryFn: async () => 5 })
      expect(await run(tools, 'query.refetch', 'expressInfo')).toMatchObject({ matched: 2, refetched: 1 })
    })
  })
})
