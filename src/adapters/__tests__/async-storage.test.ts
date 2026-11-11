import { describe, expect, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { type AsyncStorageLike, asyncStorageTools } from '../async-storage'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

function fake(): AsyncStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  const later = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 1))
  return {
    data,
    getAllKeys: () => later([...data.keys()]),
    getItem: (k) => later(data.get(k) ?? null),
    setItem: async (k, v) => void (await later(data.set(k, v))),
    removeItem: async (k) => void (await later(data.delete(k))),
    multiGet: (ks) => later(ks.map((k) => [k, data.get(k) ?? null] as const)),
  }
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
    const tools = asyncStorageTools(storage)
    await Promise.all([run(tools, 'asyncStorage.set', 'k', 'one'), run(tools, 'asyncStorage.set', 'k', 'two')])
    await run(tools, 'asyncStorage.restore')
    expect(storage.data.get('k')).toBe('orig')
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
