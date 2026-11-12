import { describe, expect, spyOn, test } from 'bun:test'
import { type Middleware, combineReducers, configureStore } from '@reduxjs/toolkit'
import { persistReducer, persistStore } from 'redux-persist'

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
    const cartBefore = store.getState().cart
    expect(await run(tools, 'redux.set', 'auth', { token: 'abc' })).toEqual({ token: 'abc' })
    expect(store.getState().auth).toEqual({ ...initial.auth, token: 'abc' })
    expect(store.getState().cart).toBe(cartBefore)
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

  test('restore keeps changes the app made to other slices after the agent\'s redux.set', async () => {
    const store = makeStore()
    const tools = reduxTools(store)
    await run(tools, 'redux.set', 'auth', { token: 'agent' })
    store.dispatch({ type: 'cart/add', payload: 'apple' })
    expect(await run(tools, 'redux.restore')).toEqual(['redux'])
    expect(store.getState().auth.token).toBe('secret')
    expect(store.getState().cart.items).toEqual(['apple'])
  })

  test('restore skips a slice the app changed since the agent set it, and says so', async () => {
    const store = makeStore()
    const tools = reduxTools(store)
    await run(tools, 'redux.set', 'auth', { token: 'agent' })
    store.dispatch({ type: 'auth/login', payload: 'rotated' })
    expect(await run(tools, 'redux.restore')).toEqual({ restored: [], skipped: ['auth'] })
    expect(store.getState().auth.token).toBe('rotated')
    expect(await pending(tools)).toBe(false)
  })

  test('restore after redux.dispatch puts the whole state back, other slices included', async () => {
    const store = makeStore()
    const tools = reduxTools(store)
    await run(tools, 'redux.dispatch', { type: 'inc' })
    store.dispatch({ type: 'cart/add', payload: 'apple' })
    await run(tools, 'redux.restore')
    expect(store.getState()).toEqual(initial)
  })

  test('the replace action carries no state through middleware', async () => {
    const seen: unknown[] = []
    const root = bridgeReducer(combineReducers({ auth: (s: { token: string } = { token: 'secret' }) => s }))
    const store = configureStore({
      reducer: root,
      middleware: (g) => g().concat(((() => (next) => (action) => (seen.push(action), next(action))) as Middleware)),
    })
    await run(reduxTools(store), 'redux.set', 'auth', { token: 'abc' })
    const replace = seen.find((a) => (a as { type: string }).type === '@@agent-bridge/replace')
    expect(replace).toEqual({ type: '@@agent-bridge/replace' })
    expect(JSON.stringify(seen)).not.toContain('abc')
  })

  test('a listener dispatching during the replace does not make a wrapped store look unwrapped', async () => {
    const root = bridgeReducer(
      combineReducers({
        auth: (s: { token: string } = { token: 'secret' }, a: { type: string }) => s,
        touches: (s: number = 0, a: { type: string }) => (a.type === 'touch' ? s + 1 : s),
      }),
    )
    const store = configureStore({
      reducer: root,
      middleware: (g) =>
        g().concat(((api) => (next) => (action) => {
          const r = next(action)
          if ((action as { type: string }).type !== 'touch') api.dispatch({ type: 'touch' })
          return r
        }) as Middleware),
    })
    const tools = reduxTools(store)
    await run(tools, 'redux.set', 'auth', { token: 'abc' })
    expect(await run(tools, 'redux.restore')).toEqual(['redux'])
    expect(store.getState().auth.token).toBe('secret')
    expect(await pending(tools)).toBe(false)
  })

  test('redux.set refuses array slices and array partials', async () => {
    const store = configureStore({
      reducer: bridgeReducer(combineReducers({ list: (s: string[] = ['a']) => s, auth: (s: object = {}) => s })),
    })
    const tools = reduxTools(store)
    await fails(() => run(tools, 'redux.set', 'list', { 0: 'x' })).toThrow(/array/)
    await fails(() => run(tools, 'redux.set', 'auth', ['x'])).toThrow(/object/)
    expect(store.getState().list).toEqual(['a'])
    expect(await pending(tools)).toBe(false)
  })

  test('a non-object root state is redacted in pending detail', async () => {
    const store = configureStore({
      reducer: bridgeReducer((s: number = 5, a: { type: string }) => (a.type === 'inc' ? s + 1 : s)),
    })
    const tools = reduxTools(store, { redact: { state: true } })
    await run(tools, 'redux.dispatch', { type: 'inc' })
    expect(await pending(tools, true)).toEqual({
      state: { '(value)': { snapshot: '[redacted]', current: '[redacted]' } },
    })
  })

  test('errors name the redux tool, and redact keys that match no slice are warned about once', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const tools = reduxTools(makeStore(), { redact: { authh: ['token'] } })
    await fails(() => run(tools, 'redux.get', 'auth', { bogus: true })).toThrow(/redux\.get option/)
    await fails(() => run(tools, 'redux.get', { x: 1 }, 5, {})).toThrow()
    await run(tools, 'redux.get')
    await run(tools, 'redux.get')
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('authh'))).toHaveLength(1)
    warn.mockRestore()
  })
})

const memoryStorage = () => {
  const m = new Map<string, string>()
  return {
    m,
    getItem: async (k: string) => m.get(k) ?? null,
    setItem: async (k: string, v: string) => void m.set(k, v),
    removeItem: async (k: string) => void m.delete(k),
  }
}
const persisted = (storage: ReturnType<typeof memoryStorage>) => {
  const root = persistReducer(
    { key: 'root', storage },
    bridgeReducer(
      combineReducers({
        auth: (s: State['auth'] = initial.auth) => s,
        count: (s: number = 0, a: { type: string }) => (a.type === 'inc' ? s + 1 : s),
      }),
    ),
  )
  const store = configureStore({ reducer: root, middleware: (g) => g({ serializableCheck: false }) })
  const persistor = persistStore(store)
  const ready = new Promise<void>((res) => {
    const check = () => persistor.getState().bootstrapped && res()
    persistor.subscribe(check)
    check()
  })
  return { store, persistor, ready }
}
const saved = (s: ReturnType<typeof memoryStorage>) => JSON.parse(JSON.parse(s.m.get('persist:root') ?? '{}').auth ?? 'null')

describe('reduxTools with redux-persist', () => {
  test('the saved copy follows a restore', async () => {
    const storage = memoryStorage()
    const { store, persistor, ready } = persisted(storage)
    await ready
    const tools = reduxTools(store)
    await run(tools, 'redux.set', 'auth', { token: 'agent' })
    await persistor.flush()
    expect(saved(storage).token).toBe('agent')
    await run(tools, 'redux.restore')
    await persistor.flush()
    expect(saved(storage).token).toBe('secret')
  })

  test('a snapshot taken before rehydration never puts _persist back', async () => {
    const storage = memoryStorage()
    const { store, persistor, ready } = persisted(storage)
    const tools = reduxTools(store)
    await run(tools, 'redux.dispatch', { type: 'inc' })
    await ready
    await run(tools, 'redux.restore')
    expect((store.getState() as { _persist: { rehydrated: boolean } })._persist.rehydrated).toBe(true)
    await run(tools, 'redux.dispatch', { type: 'inc' })
    await persistor.flush()
    expect(JSON.parse(storage.m.get('persist:root')!).count).toBe('1')
  })
})
