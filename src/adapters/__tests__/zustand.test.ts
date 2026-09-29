import { describe, expect, test } from 'bun:test'
import { createStore } from 'zustand/vanilla'

import type { ToolFn, Tools } from '../../runtime/types'
import { storeTools } from '../zustand'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

type Settings = { colorScheme: string; auth: { isLoggedIn: boolean }; setColorScheme: (c: string) => void }

describe('storeTools', () => {
  const settings = createStore<Settings>()((set) => ({
    colorScheme: 'system',
    auth: { isLoggedIn: true },
    setColorScheme: (colorScheme) => set({ colorScheme }),
  }))
  const tools = storeTools({ settings })

  test('reads a whole store or a dotted path', () => {
    expect(run(tools, 'store.get', 'settings', 'auth.isLoggedIn')).toBe(true)
    expect(run(tools, 'store.list')).toEqual(['settings'])
  })

  test('merges state and calls actions', () => {
    run(tools, 'store.set', 'settings', { colorScheme: 'light' })
    expect(settings.getState().colorScheme).toBe('light')
    run(tools, 'store.call', 'settings', 'setColorScheme', 'dark')
    expect(settings.getState().colorScheme).toBe('dark')
  })

  test('names the stores and actions that exist when one is wrong', () => {
    expect(() => run(tools, 'store.get', 'nope')).toThrow('Known: settings')
    expect(() => run(tools, 'store.call', 'settings', 'missing')).toThrow('has no action "missing"')
  })

  test('store.restore puts back state from before the first change, across rebuilt tools', () => {
    const store = createStore<Settings>()((set) => ({
      colorScheme: 'system',
      auth: { isLoggedIn: true },
      setColorScheme: (colorScheme) => set({ colorScheme }),
    }))
    const other = createStore(() => ({ n: 1 }))
    run(storeTools({ store, other }), 'store.call', 'store', 'setColorScheme', 'dark')
    run(storeTools({ store, other }), 'store.set', 'store', { auth: { isLoggedIn: false }, extra: 1 })

    expect(run(storeTools({ store, other }), 'store.restore')).toEqual(['store'])
    const state = store.getState() as Settings & { extra?: number }
    expect(state.colorScheme).toBe('system')
    expect(state.auth.isLoggedIn).toBe(true)
    expect('extra' in state).toBe(false)
    state.setColorScheme('light')
    expect(store.getState().colorScheme).toBe('light')

    // The snapshot is cleared, so a later restore has nothing to do.
    expect(run(storeTools({ store, other }), 'store.restore')).toEqual([])
    expect(store.getState().colorScheme).toBe('light')
  })

  describe('store.get paths', () => {
    const app = createStore(() => ({
      auth: { isLoggedIn: true, token: 'secret' },
      settings: { fontScale: 1.2 },
      items: [{ id: 'a' }],
      n: 0,
    }))
    const t = storeTools({ app })

    test('a path is a dotted string, an array, or the remaining args', () => {
      expect(run(t, 'store.get', 'app', 'auth.isLoggedIn')).toBe(true)
      expect(run(t, 'store.get', 'app', 'auth', 'isLoggedIn')).toBe(true)
      expect(run(t, 'store.get', 'app', ['auth', 'isLoggedIn'])).toBe(true)
      expect(run(t, 'store.get', 'app', 'items', 0, 'id')).toBe('a')
      expect(run(t, 'store.get', 'app', 'auth')).toEqual({ isLoggedIn: true, token: 'secret' })
    })

    test('pick returns just the fields, relative to the path', () => {
      expect(run(t, 'store.get', 'app', { pick: ['auth.isLoggedIn', 'settings.fontScale'] })).toEqual({
        'auth.isLoggedIn': true,
        'settings.fontScale': 1.2,
      })
      expect(run(t, 'store.get', 'app', 'auth', { pick: ['isLoggedIn'] })).toEqual({ isLoggedIn: true })
    })

    test('a null or undefined path means the whole state', () => {
      expect(run(t, 'store.get', 'app', null)).toEqual(app.getState())
      expect(run(t, 'store.get', 'app', undefined, { pick: ['n'] })).toEqual({ n: 0 })
    })

    test('keys lists top-level keys and types without values', () => {
      expect(run(t, 'store.get', 'app', { keys: true })).toEqual({
        auth: 'object',
        settings: 'object',
        items: 'array',
        n: 'number',
      })
    })

    test('rejects a bad path part or option', () => {
      expect(() => run(t, 'store.get', 'app', true)).toThrow('dotted string')
      expect(() => run(t, 'store.get', 'app', { picks: [] })).toThrow('Unknown store.get option "picks"')
    })
  })

  describe('write output and redaction', () => {
    type Auth = { accessToken: string; user: { name: string; phone: string }; isLoggedIn: boolean; logout: () => void; whoami: () => unknown; refresh: () => Promise<unknown> }
    const makeAuth = () =>
      createStore<Auth>()((set, get) => ({
        accessToken: 'secret-token',
        user: { name: 'Ada', phone: '555-0100' },
        isLoggedIn: true,
        logout: () => set({ isLoggedIn: false }),
        whoami: () => get().user,
        refresh: async () => {
          await Promise.resolve()
          set({ accessToken: 'refreshed' })
        },
      }))

    test('store.set returns only the changed keys', () => {
      const auth = makeAuth()
      const result = run(storeTools({ auth }), 'store.set', 'auth', { isLoggedIn: false })
      expect(result).toEqual({ isLoggedIn: false })
      expect(JSON.stringify(result)).not.toContain('secret-token')
    })

    test('store.call reports changed keys instead of the state', async () => {
      const auth = makeAuth()
      const result = await run(storeTools({ auth }), 'store.call', 'auth', 'logout')
      expect(result).toEqual({ changed: ['isLoggedIn'] })
      expect(JSON.stringify(result)).not.toContain('secret-token')
      expect(await run(storeTools({ auth }), 'store.call', 'auth', 'whoami')).toEqual({ name: 'Ada', phone: '555-0100' })
    })

    test('redact paths apply to get, set and call output', async () => {
      const auth = makeAuth()
      const tools = storeTools({ auth }, { redact: { auth: ['accessToken', 'user.phone'] } })
      expect(run(tools, 'store.get', 'auth')).toMatchObject({ accessToken: '[redacted]', user: { name: 'Ada', phone: '[redacted]' } })
      expect(run(tools, 'store.get', 'auth', 'accessToken')).toBe('[redacted]')
      expect(run(tools, 'store.get', 'auth', 'user.phone')).toBe('[redacted]')
      expect(run(tools, 'store.get', 'auth', 'user.name')).toBe('Ada')
      expect(run(tools, 'store.set', 'auth', { accessToken: 'new-secret' })).toEqual({ accessToken: '[redacted]' })
      expect(auth.getState().accessToken).toBe('new-secret')
      expect(await run(tools, 'store.call', 'auth', 'whoami')).toEqual({ name: 'Ada', phone: '[redacted]' })
    })

    test('store.call awaits async actions, with and without redact', async () => {
      const auth = makeAuth()
      expect(await run(storeTools({ auth }), 'store.call', 'auth', 'refresh')).toEqual({ changed: ['accessToken'] })
      expect(auth.getState().accessToken).toBe('refreshed')

      const tools = storeTools({ auth }, { redact: { auth: ['accessToken', 'user.phone'] } })
      auth.setState({ accessToken: 'again' })
      expect(await run(tools, 'store.call', 'auth', 'refresh')).toEqual({ changed: ['accessToken'] })
      auth.setState({ whoami: async () => auth.getState().user })
      expect(await run(tools, 'store.call', 'auth', 'whoami')).toEqual({ name: 'Ada', phone: '[redacted]' })
    })

    test('redaction also covers split paths and pick', () => {
      const auth = makeAuth()
      const tools = storeTools({ auth }, { redact: { auth: ['accessToken', 'user.phone'] } })
      expect(run(tools, 'store.get', 'auth', 'user', 'phone')).toBe('[redacted]')
      expect(run(tools, 'store.get', 'auth', ['user', 'phone'])).toBe('[redacted]')
      expect(run(tools, 'store.get', 'auth', { pick: ['accessToken', 'user.name'] })).toEqual({
        accessToken: '[redacted]',
        'user.name': 'Ada',
      })
      expect(run(tools, 'store.get', 'auth', 'user', { pick: ['phone'] })).toEqual({ phone: '[redacted]' })
    })

    test('a redact hook sees each store, path and value', () => {
      const auth = makeAuth()
      const tools = storeTools({ auth }, { redact: (_s, path, value) => (path.endsWith('Token') ? 'x' : value) })
      expect(run(tools, 'store.get', 'auth')).toMatchObject({ accessToken: 'x', isLoggedIn: true })
    })
  })
})

describe('store.restore pending and store.commit', () => {
  const make = () => {
    const auth = createStore<{ user: string; token: string }>()(() => ({ user: 'ada', token: 'secret' }))
    const tools = storeTools({ auth }, { redact: { auth: ['token'] } })
    const pending = () => (tools['store.restore'] as { pending: () => unknown }).pending()
    return { auth, tools, pending }
  }

  test('pending is false until a bridge write, then shows snapshot against current, redacted', () => {
    const { tools, pending } = make()
    expect(pending()).toBe(false)
    run(tools, 'store.set', 'auth', { user: 'grace', token: 'other' })
    expect(pending()).toEqual({
      auth: {
        user: { snapshot: 'ada', current: 'grace' },
        token: { snapshot: '[redacted]', current: '[redacted]' },
      },
    })
  })

  test('long values are cut', () => {
    const { tools, pending } = make()
    run(tools, 'store.set', 'auth', { user: 'x'.repeat(500) })
    const detail = (pending() as Record<string, Record<string, { current: string }>>).auth!.user!
    expect(detail.current.length).toBeLessThan(300)
    expect(detail.current).toContain('502 chars')
  })

  test('store.commit keeps the current value: restore leaves it alone, and the next write snapshots again', () => {
    const { auth, tools, pending } = make()
    run(tools, 'store.set', 'auth', { user: 'broken' })
    run(tools, 'store.set', 'auth', { user: 'fixed' })
    expect(run(tools, 'store.commit', 'auth')).toEqual({ store: 'auth', committed: true })
    expect(pending()).toBe(false)
    expect(run(tools, 'store.restore')).toEqual([])
    expect(auth.getState().user).toBe('fixed')
    expect(run(tools, 'store.commit', 'auth')).toEqual({ store: 'auth', committed: false })

    run(tools, 'store.set', 'auth', { user: 'later' })
    expect(run(tools, 'store.restore')).toEqual(['auth'])
    expect(auth.getState().user).toBe('fixed')
    expect(() => run(tools, 'store.commit', 'nope')).toThrow('Unknown store')
  })
})
