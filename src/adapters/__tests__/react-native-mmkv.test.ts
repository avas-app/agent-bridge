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
