import { describe, expect, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { type SecureStoreLike, type SecureStoreOptions, secureStoreTools } from '../secure-store'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

// Like expo-secure-store: a keychainService is a separate namespace, and an item
// stored with requireAuthentication fails to read when no biometrics are enrolled.
function fake() {
  const data = new Map<string, { value: string; auth: boolean }>()
  const calls: { op: string; key: string; options?: SecureStoreOptions }[] = []
  const delays: { getItemAsync?: number[] } = {}
  const slot = (k: string, o?: SecureStoreOptions) => `${o?.keychainService ?? 'app'}\u0000${k}`
  const later = <T>(v: () => T, queue?: number[]) =>
    new Promise<T>((r, j) =>
      setTimeout(() => {
        try {
          r(v())
        } catch (e) {
          j(e)
        }
      }, queue?.shift() ?? 1),
    )
  const api: SecureStoreLike & {
    data: typeof data
    calls: typeof calls
    delays: typeof delays
    biometrics: boolean
    raw: (k: string, service?: string) => string | undefined
  } = {
    data,
    calls,
    delays,
    biometrics: true,
    raw: (k, service) => data.get(slot(k, { keychainService: service }))?.value,
    getItemAsync: (k, o) => {
      calls.push({ op: 'get', key: k, options: o })
      return later(() => {
        const item = data.get(slot(k, o))
        if (item?.auth && !api.biometrics) throw new Error('No biometrics are enrolled')
        return item?.value ?? null
      }, delays.getItemAsync)
    },
    setItemAsync: (k, v, o) => {
      calls.push({ op: 'set', key: k, options: o })
      return later(() => void data.set(slot(k, o), { value: v, auth: o?.requireAuthentication === true }))
    },
    deleteItemAsync: (k, o) => {
      calls.push({ op: 'delete', key: k, options: o })
      return later(() => void data.delete(slot(k, o)))
    },
  }
  return api
}

const put = (store: ReturnType<typeof fake>, key: string, value: string, o?: SecureStoreOptions) =>
  store.data.set(`${o?.keychainService ?? 'app'}\u0000${key}`, { value, auth: o?.requireAuthentication === true })

describe('secureStoreTools', () => {
  test('get is redacted unless {full:true}', async () => {
    const store = fake()
    put(store, 'token', 'sekret-value')
    const tools = secureStoreTools(store)
    const hidden = await run(tools, 'secureStore.get', 'token')
    expect(hidden).toBe('[redacted, 12 chars]')
    expect(JSON.stringify(hidden)).not.toContain('sekret')
    expect(await run(tools, 'secureStore.get', 'token', { full: true })).toBe('sekret-value')
    expect(await run(tools, 'secureStore.get', 'nope')).toBeNull()
  })

  test('list shows only the keys the app passed, without values', async () => {
    const store = fake()
    put(store, 'token', 'sekret-value')
    put(store, 'other', 'x')
    const tools = secureStoreTools(store, ['token', 'missing'])
    const listed = await run(tools, 'secureStore.list')
    expect(listed).toEqual({ token: { set: true, length: 12 }, missing: { set: false } })
  })

  test('restore puts back changed keys, removes new ones, and pending shows no names', async () => {
    const store = fake()
    put(store, 'token', 'old')
    put(store, 'keep', 'k')
    await run(secureStoreTools(store), 'secureStore.set', 'token', 'new')
    await run(secureStoreTools(store), 'secureStore.set', 'token', 'newer')
    await run(secureStoreTools(store), 'secureStore.delete', 'keep')
    await run(secureStoreTools(store), 'secureStore.set', 'fresh', 'v')
    const tools = secureStoreTools(store)
    expect((tools['secureStore.restore'] as { pending: () => unknown }).pending()).toBe(true)
    expect(await run(tools, 'secureStore.restore')).toBe(3)
    expect([store.raw('token'), store.raw('keep'), store.raw('fresh')]).toEqual(['old', 'k', undefined])
    expect(await run(tools, 'secureStore.restore')).toBe(0)
  })

  test('options reach every call, including the snapshot and restore', async () => {
    const store = fake()
    const opts = { keychainService: 'auth', keychainAccessible: 1 }
    put(store, 'token', 'real', opts)
    const tools = secureStoreTools(store, ['token'], opts)
    expect(await run(tools, 'secureStore.get', 'token', { full: true })).toBe('real')
    expect(await run(tools, 'secureStore.list')).toEqual({ token: { set: true, length: 4 } })
    await run(tools, 'secureStore.set', 'token', 'agent')
    expect(store.raw('token', 'auth')).toBe('agent')
    expect(store.raw('token')).toBeUndefined()
    await run(tools, 'secureStore.restore')
    expect(store.raw('token', 'auth')).toBe('real')
    expect(store.raw('token')).toBeUndefined()
    expect(store.calls.every((c) => c.options === opts)).toBe(true)
  })

  test('options can be picked per key', async () => {
    const store = fake()
    put(store, 'a', 'one', { keychainService: 'x' })
    put(store, 'b', 'two')
    const tools = secureStoreTools(store, [], (k) => (k === 'a' ? { keychainService: 'x' } : undefined))
    expect(await run(tools, 'secureStore.get', 'a', { full: true })).toBe('one')
    expect(await run(tools, 'secureStore.get', 'b', { full: true })).toBe('two')
  })

  test('list does not read keys that need authentication', async () => {
    const store = fake()
    store.biometrics = false
    put(store, 'pin', '1234', { requireAuthentication: true })
    put(store, 'token', 'abc')
    const tools = secureStoreTools(store, ['pin', 'token'], (k) => (k === 'pin' ? { requireAuthentication: true } : undefined))
    expect(await run(tools, 'secureStore.list')).toEqual({ pin: { authRequired: true }, token: { set: true, length: 3 } })
    expect(store.calls.map((c) => c.key)).toEqual(['token'])
  })

  test('a protected key that cannot be read is not changed, and says why', async () => {
    const store = fake()
    store.biometrics = false
    const o = { requireAuthentication: true }
    put(store, 'pin', '1234', o)
    const tools = secureStoreTools(store, [], o)
    await expect(run(tools, 'secureStore.set', 'pin', '0000')).rejects.toThrow('nothing was changed')
    expect(store.calls.some((c) => c.op === 'set')).toBe(false)
    expect((tools['secureStore.restore'] as { pending: () => boolean }).pending()).toBe(false)
  })

  test('two writes at once snapshot once; a write during restore stays pending', async () => {
    const store = fake()
    put(store, 'k', 'orig')
    put(store, 'b', 'b0')
    store.delays.getItemAsync = [20]
    const tools = secureStoreTools(store)
    await Promise.all([run(tools, 'secureStore.set', 'k', 'one'), run(tools, 'secureStore.set', 'k', 'two')])
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(1)
    const restoring = run(tools, 'secureStore.restore')
    await new Promise((r) => setTimeout(r, 2))
    await run(tools, 'secureStore.set', 'b', 'b1')
    await restoring
    expect((tools['secureStore.restore'] as { pending: () => boolean }).pending()).toBe(true)
    await run(tools, 'secureStore.restore')
    expect([store.raw('k'), store.raw('b')]).toEqual(['orig', 'b0'])
  })

  test('a failed restore stays pending and the next one finishes it', async () => {
    const store = fake()
    put(store, 'a', '1')
    const tools = secureStoreTools(store)
    await run(tools, 'secureStore.set', 'a', '2')
    const set = store.setItemAsync
    store.setItemAsync = async () => {
      throw new Error('keychain locked')
    }
    await expect(run(tools, 'secureStore.restore')).rejects.toThrow('could not restore: a')
    store.setItemAsync = set
    expect(await run(tools, 'secureStore.restore')).toBe(1)
    expect(store.raw('a')).toBe('1')
  })

  test('a rejected snapshot changes nothing and leaves nothing pending', async () => {
    const store = fake()
    put(store, 'a', '1')
    const get = store.getItemAsync
    store.getItemAsync = async () => {
      throw new Error('read failed')
    }
    const tools = secureStoreTools(store)
    await expect(run(tools, 'secureStore.set', 'a', '2')).rejects.toThrow('read failed')
    expect(store.raw('a')).toBe('1')
    expect((tools['secureStore.restore'] as { pending: () => boolean }).pending()).toBe(false)
    store.getItemAsync = get
  })

  test('restore leaves a key the app has rotated since, and names only the key', async () => {
    const store = fake()
    put(store, 'refresh', 'old')
    const tools = secureStoreTools(store)
    await run(tools, 'secureStore.set', 'refresh', 'agent')
    put(store, 'refresh', 'rotated')
    const result = await run(tools, 'secureStore.restore')
    expect(result).toEqual({ restored: 0, skipped: ['refresh'] })
    expect(store.raw('refresh')).toBe('rotated')
  })

  test('set rejects a missing value before touching the keychain', async () => {
    const store = fake()
    const tools = secureStoreTools(store)
    await expect(run(tools, 'secureStore.set', 'k')).rejects.toThrow('needs a value')
    await expect(run(tools, 'secureStore.set', null, 'v')).rejects.toThrow('key name')
    expect(store.calls).toHaveLength(0)
  })
})
