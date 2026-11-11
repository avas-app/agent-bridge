import { describe, expect, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { type MMKVLike, mmkvTools } from '../react-native-mmkv'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

function fakeMmkv(api: 'delete' | 'remove'): MMKVLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  const base = {
    data,
    getAllKeys: () => [...data.keys()],
    getString: (k: string) => data.get(k),
    set: (k: string, v: string | number | boolean) => void data.set(k, String(v)),
  }
  return api === 'delete' ? { ...base, delete: (k) => void data.delete(k) } : { ...base, remove: (k) => data.delete(k) }
}

describe('mmkvTools', () => {
  test('stores objects as JSON and reads them back', () => {
    const storage = fakeMmkv('remove')
    const tools = mmkvTools({ storage })
    run(tools, 'mmkv.set', 'storage', 'prefs', { theme: 'dark' })
    expect(storage.data.get('prefs')).toBe('{"theme":"dark"}')
    expect(run(tools, 'mmkv.get', 'storage', 'prefs', { json: true })).toEqual({ theme: 'dark' })
    expect(run(tools, 'mmkv.keys', 'storage')).toEqual(['prefs'])
  })

  test('deletes with either the v3 or v4 API', () => {
    for (const api of ['delete', 'remove'] as const) {
      const storage = fakeMmkv(api)
      storage.data.set('k', 'v')
      run(mmkvTools({ storage }), 'mmkv.delete', 'storage', 'k')
      expect(storage.data.has('k')).toBe(false)
    }
  })

  test('mmkv.restore puts back changed keys and deletes new ones, across rebuilt tools', () => {
    const storage = fakeMmkv('remove')
    storage.data.set('theme', 'light')
    storage.data.set('token', 'abc')
    run(mmkvTools({ storage }), 'mmkv.set', 'storage', 'theme', 'dark')
    run(mmkvTools({ storage }), 'mmkv.set', 'storage', 'theme', 'darker')
    run(mmkvTools({ storage }), 'mmkv.delete', 'storage', 'token')
    run(mmkvTools({ storage }), 'mmkv.set', 'storage', 'seeded', { a: 1 })

    expect(run(mmkvTools({ storage }), 'mmkv.restore')).toBe(3)
    expect(Object.fromEntries(storage.data)).toEqual({ theme: 'light', token: 'abc' })
    expect(run(mmkvTools({ storage }), 'mmkv.restore')).toBe(0)
  })
})

describe('mmkv journal', () => {
  const journalOf = (tools: Tools) => (tools['mmkv.restore'] as { journal: () => unknown }).journal()
  const adopt = (tools: Tools, data: unknown) =>
    (tools['mmkv.restore'] as { adopt: (d: unknown) => unknown }).adopt(data)

  test('journals string writes and deletes, and a reload adopts them so restore undoes them', () => {
    const storage = fakeMmkv('remove')
    storage.data.set('token', 'real')
    storage.data.set('gone', 'x')
    const tools = mmkvTools({ storage })
    run(tools, 'mmkv.set', 'storage', 'token', 'fake')
    run(tools, 'mmkv.set', 'storage', 'fresh', 'new')
    run(tools, 'mmkv.delete', 'storage', 'gone')
    const journal = journalOf(tools)
    expect(journal).toEqual({
      storage: {
        token: { original: 'real', written: 'fake' },
        fresh: { original: null, written: 'new' },
        gone: { original: 'x', written: null },
      },
    })
    // A reload: same storage, new instance objects, so no in-memory undo state.
    const reloaded = mmkvTools({ storage: { ...storage } })
    const pendingBefore = (reloaded['mmkv.restore'] as { pending: () => unknown }).pending()
    expect(pendingBefore).toBe(false)
    const result = adopt(reloaded, journal) as { adopted: string[] }
    expect(result.adopted.sort()).toEqual(['storage:fresh', 'storage:gone', 'storage:token'])
    expect(storage.data.get('token')).toBe('fake')
    run(reloaded, 'mmkv.restore')
    expect(storage.data.get('token')).toBe('real')
    expect(storage.data.has('fresh')).toBe(false)
    expect(storage.data.get('gone')).toBe('x')
  })

  test('leaves a key the app changed since, and a key already back to its original', () => {
    const storage = fakeMmkv('remove')
    storage.data.set('a', 'real-a')
    storage.data.set('b', 'real-b')
    const tools = mmkvTools({ storage })
    run(tools, 'mmkv.set', 'storage', 'a', 'fake-a')
    run(tools, 'mmkv.set', 'storage', 'b', 'fake-b')
    const journal = journalOf(tools)
    storage.data.set('a', 'app-wrote-this')
    storage.data.set('b', 'real-b')
    const reloaded = mmkvTools({ storage: { ...storage } })
    expect(adopt(reloaded, journal)).toEqual({ adopted: [], already: ['storage:b'], changed: ['storage:a'] })
    run(reloaded, 'mmkv.restore')
    expect(storage.data.get('a')).toBe('app-wrote-this')
  })

  test('drops entries of the wrong shape and names them, and restores the rest', () => {
    const storage = fakeMmkv('remove')
    storage.data.set('a', 'fake-a')
    storage.data.set('b', 'fake-b')
    const tools = mmkvTools({ storage })
    const result = adopt(tools, {
      storage: { a: { original: { evil: 1 }, written: 'fake-a' }, b: { original: 'real-b', written: 'fake-b' } },
      other: 'nope',
    })
    expect(result).toEqual({ adopted: ['storage:b'], already: [], changed: [], invalid: ['storage:a', 'other'] })
    run(tools, 'mmkv.restore')
    expect(storage.data.get('b')).toBe('real-b')
    expect(storage.data.get('a')).toBe('fake-a')
  })

  test('keeps the journal original when the new load already saved the fake value', () => {
    const storage = fakeMmkv('remove')
    storage.data.set('t', 'real')
    const journal = journalOf((() => {
      const t = mmkvTools({ storage })
      run(t, 'mmkv.set', 'storage', 't', 'fake')
      return t
    })())
    const reloaded = mmkvTools({ storage: { ...storage } })
    run(reloaded, 'mmkv.set', 'storage', 't', 'fake2')
    adopt(reloaded, journal)
    run(reloaded, 'mmkv.restore')
    expect(storage.data.get('t')).toBe('real')
  })

  test('asks to retry an instance that is not registered yet; skips numbers', () => {
    const storage = fakeMmkv('remove')
    const tools = mmkvTools({ storage })
    run(tools, 'mmkv.set', 'storage', 'n', 5)
    expect(journalOf(tools)).toBeUndefined()
    const data = { late: { k: { original: null, written: 'v' } } }
    expect(adopt(tools, data)).toMatchObject({ retry: data })
  })
})
