import { describe, expect, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { type SecureStoreLike, secureStoreTools } from '../secure-store'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

function fake(): SecureStoreLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItemAsync: async (k) => data.get(k) ?? null,
    setItemAsync: async (k, v) => void data.set(k, v),
    deleteItemAsync: async (k) => void data.delete(k),
  }
}

describe('secureStoreTools', () => {
  test('get is redacted unless {full:true}', async () => {
    const store = fake()
    store.data.set('token', 'sekret-value')
    const tools = secureStoreTools(store)
    const hidden = await run(tools, 'secureStore.get', 'token')
    expect(hidden).toBe('[redacted, 12 chars]')
    expect(JSON.stringify(hidden)).not.toContain('sekret')
    expect(await run(tools, 'secureStore.get', 'token', { full: true })).toBe('sekret-value')
    expect(await run(tools, 'secureStore.get', 'nope')).toBeNull()
  })

  test('list shows only the keys the app passed, without values', async () => {
    const store = fake()
    store.data.set('token', 'sekret-value')
    store.data.set('other', 'x')
    const tools = secureStoreTools(store, ['token', 'missing'])
    const listed = await run(tools, 'secureStore.list')
    expect(listed).toEqual({ token: { set: true, length: 12 }, missing: { set: false } })
  })

  test('restore puts back changed keys, removes new ones, and pending shows no names', async () => {
    const store = fake()
    store.data.set('token', 'old')
    store.data.set('keep', 'k')
    await run(secureStoreTools(store), 'secureStore.set', 'token', 'new')
    await run(secureStoreTools(store), 'secureStore.set', 'token', 'newer')
    await run(secureStoreTools(store), 'secureStore.delete', 'keep')
    await run(secureStoreTools(store), 'secureStore.set', 'fresh', 'v')
    const tools = secureStoreTools(store)
    expect((tools['secureStore.restore'] as { pending: () => unknown }).pending()).toBe(true)
    expect(await run(tools, 'secureStore.restore')).toBe(3)
    expect(Object.fromEntries(store.data)).toEqual({ token: 'old', keep: 'k' })
    expect(await run(tools, 'secureStore.restore')).toBe(0)
  })
})
