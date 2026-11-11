import { describe, expect, test } from 'bun:test'
import { combineReducers, configureStore } from '@reduxjs/toolkit'

import type { ToolFn, Tools } from '../../runtime/types'
import { bridgeReducer, reduxTools } from '../redux'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}
const fails = (fn: () => unknown) => expect((async () => fn())()).rejects
const pending = (tools: Tools, detail?: boolean) => {
  const t = tools['redux.restore']
  return typeof t === 'object' && t.pending ? t.pending({ detail }) : undefined
}

type State = {
  auth: { token: string | null; user: { name: string; phone: string } | null }
  cart: { items: string[] }
  count: number
}

const initial: State = {
  auth: { token: 'secret', user: { name: 'Ada', phone: '555' } },
  cart: { items: [] },
  count: 0,
}

function makeStore(wrap = true) {
  const root = combineReducers({
    auth: (s: State['auth'] = initial.auth, a: { type: string; payload?: unknown }) =>
      a.type === 'auth/login' ? { ...s, token: a.payload as string } : s,
    cart: (s: State['cart'] = initial.cart, a: { type: string; payload?: unknown }) =>
      a.type === 'cart/add' ? { items: [...s.items, a.payload as string] } : s,
    count: (s: number = initial.count, a: { type: string }) => (a.type === 'inc' ? s + 1 : s),
  })
  return configureStore({
    reducer: wrap ? bridgeReducer(root) : root,
    middleware: (g) => g({ serializableCheck: false }),
  })
}

describe('reduxTools', () => {
  test('lists slices and reads state, paths, pick and keys', async () => {
    const tools = reduxTools(makeStore())
    expect(await run(tools, 'redux.list')).toEqual(['auth', 'cart', 'count'])
    expect(await run(tools, 'redux.get', 'cart')).toEqual({ items: [] })
    expect(await run(tools, 'redux.get', 'auth.user.name')).toBe('Ada')
    expect(await run(tools, 'redux.get', 'auth', { pick: ['token'] })).toEqual({ token: 'secret' })
    expect(await run(tools, 'redux.get', 'auth', { keys: true })).toEqual({ token: 'string', user: 'object' })
    expect(await run(tools, 'redux.get')).toEqual(initial)
  })

  test('dispatch runs an action and reports the slices that changed', async () => {
    const store = makeStore()
    const tools = reduxTools(store)
    expect(await run(tools, 'redux.dispatch', { type: 'cart/add', payload: 'apple' })).toEqual({
      changed: ['cart'],
    })
    expect(store.getState().cart.items).toEqual(['apple'])
    await fails(() => run(tools, 'redux.dispatch', 'nope')).toThrow(/{ type, payload }/)
    await fails(() => run(tools, 'redux.dispatch', { type: '@@agent-bridge/replace' })).toThrow(/reserved/)
  })

  test('set merges into a slice and returns only the keys set', async () => {
    const store = makeStore()
    const tools = reduxTools(store)
    expect(await run(tools, 'redux.set', 'auth', { token: 'abc' })).toEqual({ token: 'abc' })
    expect(store.getState().auth).toEqual({ ...initial.auth, token: 'abc' })
    expect(store.getState().cart).toBe(store.getState().cart)
    await fails(() => run(tools, 'redux.set', 'nope', {})).toThrow(/Unknown slice "nope"/)
    await fails(() => run(tools, 'redux.set', 'count', {})).toThrow(/not an object/)
  })

  test('restore puts back the state from before the first change', async () => {
    const store = makeStore()
    const tools = reduxTools(store)
    expect(await pending(tools)).toBe(false)
    await run(tools, 'redux.set', 'auth', { token: 'one' })
    await run(tools, 'redux.dispatch', { type: 'inc' })
    await run(tools, 'redux.set', 'auth', { token: 'two' })
    expect(await pending(tools)).toBe(true)
    expect(await pending(tools, true)).toEqual({
      auth: { token: { snapshot: 'secret', current: 'two' } },
      count: { '(value)': { snapshot: 0, current: 1 } },
    })
    expect(await run(tools, 'redux.restore')).toEqual(['redux'])
    expect(store.getState()).toEqual(initial)
    expect(await pending(tools)).toBe(false)
    expect(await run(tools, 'redux.restore')).toEqual([])
  })

  test('snapshot survives tools rebuilt on every render', async () => {
    const store = makeStore()
    await run(reduxTools(store), 'redux.set', 'cart', { items: ['x'] })
    expect(await run(reduxTools(store), 'redux.restore')).toEqual(['redux'])
    expect(store.getState().cart.items).toEqual([])
  })

  test('commit keeps the current state and snapshots again next time', async () => {
    const store = makeStore()
    const tools = reduxTools(store)
    await run(tools, 'redux.dispatch', { type: 'inc' })
    expect(await run(tools, 'redux.commit')).toEqual({ committed: true })
    expect(await run(tools, 'redux.commit')).toEqual({ committed: false })
    await run(tools, 'redux.dispatch', { type: 'inc' })
    await run(tools, 'redux.restore')
    expect(store.getState().count).toBe(1)
  })

  test('without bridgeReducer the change fails with a fix, and nothing stays pending', async () => {
    const store = makeStore(false)
    const tools = reduxTools(store)
    await fails(() => run(tools, 'redux.set', 'auth', { token: 'x' })).toThrow(/bridgeReducer/)
    expect(await pending(tools)).toBe(false)
    expect(store.getState().auth.token).toBe('secret')
  })

  test('redact hides slices and paths in get, set, dispatch and pending', async () => {
    const store = makeStore()
    const tools = reduxTools(store, { redact: { auth: ['token', 'user.phone'], count: true } })
    expect(await run(tools, 'redux.get', 'auth')).toEqual({
      token: '[redacted]',
      user: { name: 'Ada', phone: '[redacted]' },
    })
    expect(await run(tools, 'redux.get', 'count')).toBe('[redacted]')
    expect(await run(tools, 'redux.set', 'auth', { token: 'abc' })).toEqual({ token: '[redacted]' })
    expect(await pending(tools, true)).toEqual({
      auth: { token: { snapshot: '[redacted]', current: '[redacted]' } },
    })
  })

  test('a redact hook sees the slice and each path; the slice itself has an empty path', async () => {
    const seen: string[] = []
    const tools = reduxTools(makeStore(), {
      redact: (slice, path, value) => {
        seen.push(`${slice}:${path}`)
        return path === 'token' ? 'x' : value
      },
    })
    const out = (await run(tools, 'redux.get', 'auth')) as State['auth']
    expect(out.token).toBe('x')
    expect(seen).toContain('auth:')
    expect(seen).toContain('auth:user.name')
  })

  test('restore works through a redux-persist style wrapper outside the persisted reducer', async () => {
    const inner = (s: { n: number } | undefined, a: { type: string }) => ({ n: (s?.n ?? 0) + (a.type === 'inc' ? 1 : 0) })
    // persistReducer adds a _persist key to the state it manages
    const persisted = (s: { n: number; _persist?: { rehydrated: boolean } } | undefined, a: { type: string }) => ({
      ...inner(s, a),
      _persist: s?._persist ?? { rehydrated: true },
    })
    const store = configureStore({ reducer: bridgeReducer(persisted), middleware: (g) => g({ serializableCheck: false }) })
    const tools = reduxTools(store)
    await run(tools, 'redux.dispatch', { type: 'inc' })
    await run(tools, 'redux.restore')
    expect(store.getState()).toEqual({ n: 0, _persist: { rehydrated: true } })
  })
})
