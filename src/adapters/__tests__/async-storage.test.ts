import { describe, expect, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { type AsyncStorageLike, asyncStorageTools } from '../async-storage'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

function fake() {
  const data = new Map<string, string>()
  const delays: { getItem?: number[]; setItem?: number[] } = {}
  let reads = 0
  // Each call takes 1 ms unless a delay is queued for it, so calls can finish out of order.
  const later = <T>(v: () => T, queue?: number[]) =>
    new Promise<T>((r) => setTimeout(() => r(v()), queue?.shift() ?? 1))
  const api: AsyncStorageLike & {
    data: Map<string, string>
    delays: typeof delays
    reads: number
  } = {
    data,
    delays,
    get reads() {
      return reads
    },
    getAllKeys: () => later(() => [...data.keys()]),
    getItem: (k) => {
      reads += 1
      // The value is read when the call lands, as a real store does.
      return later(() => data.get(k) ?? null, delays.getItem)
    },
    setItem: (k, v) => later(() => void data.set(k, v), delays.setItem),
    removeItem: (k) => later(() => void data.delete(k)),
    multiGet: (ks) => later(() => ks.map((k) => [k, data.get(k) ?? null] as const)),
  }
  return api
}

describe('asyncStorageTools', () => {
  test('stores objects as JSON and reads them back', async () => {
    const storage = fake()
    const tools = asyncStorageTools(storage)
    await run(tools, 'asyncStorage.set', 'prefs', { theme: 'dark' })
    expect(storage.data.get('prefs')).toBe('{"theme":"dark"}')
    expect(await run(tools, 'asyncStorage.get', 'prefs', { json: true })).toEqual({ theme: 'dark' })
    expect(await run(tools, 'asyncStorage.get', 'nope')).toBeNull()
  })

  test('list limits rows, filters by prefix and cuts long values', async () => {
    const storage = fake()
    storage.data.set('a:1', 'x'.repeat(500))
    storage.data.set('a:2', 'two')
    storage.data.set('b:1', 'one')
    const tools = asyncStorageTools(storage)
    const all = (await run(tools, 'asyncStorage.list', { prefix: 'a:' })) as { total: number; keys: Record<string, string> }
    expect(all.total).toBe(2)
    expect(all.keys['a:1']!.length).toBeLessThan(260)
    expect(all.keys['a:1']).toContain('500 chars')
    const one = (await run(tools, 'asyncStorage.list', { limit: 1 })) as { total: number; keys: object }
    expect(one.total).toBe(3)
    expect(Object.keys(one.keys)).toHaveLength(1)
  })

  test('restore puts back changed keys and deletes new ones, across rebuilt tools', async () => {
    const storage = fake()
    storage.data.set('theme', 'light')
    storage.data.set('token', 'abc')
    await run(asyncStorageTools(storage), 'asyncStorage.set', 'theme', 'dark')
    await run(asyncStorageTools(storage), 'asyncStorage.set', 'theme', 'darker')
    await run(asyncStorageTools(storage), 'asyncStorage.delete', 'token')
    await run(asyncStorageTools(storage), 'asyncStorage.set', 'seeded', { a: 1 })
    const tools = asyncStorageTools(storage)
    expect((tools['asyncStorage.restore'] as { pending: () => boolean }).pending()).toBe(true)

    expect(await run(tools, 'asyncStorage.restore')).toBe(3)
    expect(Object.fromEntries(storage.data)).toEqual({ theme: 'light', token: 'abc' })
    expect(await run(tools, 'asyncStorage.restore')).toBe(0)
    expect((tools['asyncStorage.restore'] as { pending: () => boolean }).pending()).toBe(false)
  })

  test('two writes at once to one key still restore the first original', async () => {
    const storage = fake()
    storage.data.set('k', 'orig')
    // The first read is slow and the first write lands before the second read would start.
    storage.delays.getItem = [20]
    const tools = asyncStorageTools(storage)
    await Promise.all([
      run(tools, 'asyncStorage.set', 'k', 'one'),
      run(tools, 'asyncStorage.set', 'k', 'two'),
    ])
    expect(storage.reads).toBe(1)
    await run(tools, 'asyncStorage.restore')
    expect(storage.data.get('k')).toBe('orig')
  })

  test('a key written during a restore stays pending and is restored next time', async () => {
    const storage = fake()
    storage.data.set('a', 'a0')
    storage.data.set('b', 'b0')
    const tools = asyncStorageTools(storage)
    await run(tools, 'asyncStorage.set', 'a', 'a1')
    storage.delays.setItem = [30]
    const restoring = run(tools, 'asyncStorage.restore')
    await new Promise((r) => setTimeout(r, 5))
    await run(tools, 'asyncStorage.set', 'b', 'b1')
    await restoring
    expect((tools['asyncStorage.restore'] as { pending: () => boolean }).pending()).toBe(true)
    await run(tools, 'asyncStorage.restore')
    expect(Object.fromEntries(storage.data)).toEqual({ a: 'a0', b: 'b0' })
  })

  test('restore leaves a key the app has written since, and says so', async () => {
    const storage = fake()
    storage.data.set('refresh', 'old')
    storage.data.set('theme', 'light')
    const tools = asyncStorageTools(storage)
    await run(tools, 'asyncStorage.set', 'refresh', 'agent')
    await run(tools, 'asyncStorage.set', 'theme', 'dark')
    storage.data.set('refresh', 'rotated-by-app')
    expect(await run(tools, 'asyncStorage.restore')).toEqual({ restored: 1, skipped: ['refresh'] })
    expect(Object.fromEntries(storage.data)).toEqual({ refresh: 'rotated-by-app', theme: 'light' })
    expect((tools['asyncStorage.restore'] as { pending: () => boolean }).pending()).toBe(false)
  })

  test('a rejected snapshot read changes nothing and leaves nothing pending', async () => {
    const storage = fake()
    storage.data.set('k', 'v')
    const getItem = storage.getItem
    storage.getItem = async () => {
      throw new Error('read failed')
    }
    const tools = asyncStorageTools(storage)
    await expect(run(tools, 'asyncStorage.set', 'k', 'x')).rejects.toThrow('read failed')
    expect(storage.data.get('k')).toBe('v')
    expect((tools['asyncStorage.restore'] as { pending: () => boolean }).pending()).toBe(false)
    storage.getItem = getItem
    expect(await run(tools, 'asyncStorage.restore')).toBe(0)
  })

  test('set rejects a missing key or value before reading or writing', async () => {
    const storage = fake()
    const tools = asyncStorageTools(storage)
    await expect(run(tools, 'asyncStorage.set', 'k')).rejects.toThrow('needs a value')
    await expect(run(tools, 'asyncStorage.set', 'k', null)).rejects.toThrow('use the delete tool')
    await expect(run(tools, 'asyncStorage.set', undefined, 'v')).rejects.toThrow('key name')
    await expect(run(tools, 'asyncStorage.delete')).rejects.toThrow('key name')
    expect(storage.reads).toBe(0)
    expect(storage.data.size).toBe(0)
  })

  test('a key that fails to restore stays pending and restore throws', async () => {
    const storage = fake()
    storage.data.set('a', '1')
    const tools = asyncStorageTools(storage)
    await run(tools, 'asyncStorage.set', 'a', '2')
    const setItem = storage.setItem
    storage.setItem = async () => {
      throw new Error('disk full')
    }
    await expect(run(tools, 'asyncStorage.restore')).rejects.toThrow('could not restore: a')
    storage.setItem = setItem
    expect(await run(tools, 'asyncStorage.restore')).toBe(1)
    expect(storage.data.get('a')).toBe('1')
  })
})
