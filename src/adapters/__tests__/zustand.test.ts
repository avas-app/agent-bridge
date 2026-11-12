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
    const hook = tools['store.restore'] as { pending: (o?: { detail?: boolean }) => unknown }
    const pending = () => hook.pending({ detail: true })
    return { auth, tools, pending, hook }
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

describe('store pending edge cases', () => {
  type S = { data: unknown; user: { phone: string; name: string } }
  const make = (redact: Parameters<typeof storeTools>[1]) => {
    const app = createStore<S>()(() => ({ data: 1, user: { phone: '555', name: 'ada' } }))
    const tools = storeTools({ app }, redact)
    const hook = tools['store.restore'] as { pending: (o?: { detail?: boolean }) => unknown }
    return { tools, detail: () => hook.pending({ detail: true }) as Record<string, Record<string, { current: unknown }>>, hook }
  }

  test('cyclic and BigInt values do not drop the store from pending', () => {
    const { tools, detail, hook } = make(undefined)
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    run(tools, 'store.set', 'app', { data: cyclic })
    expect(detail().app!.data!.current).toEqual({ a: 1, self: '[Circular]' })
    run(tools, 'store.set', 'app', { data: 10n })
    expect(detail().app!.data!.current).toBe('10')
    expect(hook.pending()).toBe(true)
  })

  test('nested-path redaction applies in pending detail', () => {
    const { tools, detail } = make({ redact: { app: ['user.phone'] } })
    run(tools, 'store.set', 'app', { user: { phone: '999', name: 'grace' } })
    const current = detail().app!.user!.current as { phone: string; name: string }
    expect(current).toEqual({ phone: '[redacted]', name: 'grace' })
  })

  test('a redact function applies in pending detail', () => {
    const { tools, detail } = make({ redact: (_s, path, v) => (path === 'user.phone' ? 'hidden' : v) })
    run(tools, 'store.set', 'app', { user: { phone: '999', name: 'grace' } })
    const current = detail().app!.user!.current as { phone: string }
    expect(current.phone).toBe('hidden')
  })
})

describe('store journal', () => {
  type S = { token: string; theme: string; setTheme: (t: string) => void }
  // zustand's persist middleware is faked: only the parts the adapter reads.
  const make = (state: Partial<S>, hydrated = true) => {
    const store = createStore<S>()((set) => ({
      token: 'real',
      theme: 'light',
      setTheme: (theme) => set({ theme }),
      ...state,
    }))
    return Object.assign(store, {
      persist: {
        getOptions: () => ({ partialize: (s: S) => ({ token: s.token }) }),
        hasHydrated: () => hydrated,
        onFinishHydration: () => () => {},
      },
    })
  }
  const part = (tools: Tools) => tools['store.restore'] as {
    journal: () => unknown
    adopt: (d: unknown) => Promise<unknown>
  }

  test('journals only the persisted part of a persisted store', () => {
    const auth = make({})
    const tools = storeTools({ auth })
    run(tools, 'store.set', 'auth', { token: 'fake', theme: 'dark' })
    expect(part(tools).journal()).toEqual({
      auth: { original: { token: 'real' }, after: { token: 'fake' } },
    })
  })

  test('does not journal a store without persist', () => {
    const plain = createStore<{ a: number }>()(() => ({ a: 1 }))
    const tools = storeTools({ plain })
    run(tools, 'store.set', 'plain', { a: 2 })
    expect(part(tools).journal()).toBeUndefined()
  })

  test('after a reload, adopt re-arms the snapshot so restore puts the original back', async () => {
    const auth = make({})
    const tools = storeTools({ auth })
    run(tools, 'store.set', 'auth', { token: 'fake' })
    const journal = part(tools).journal()
    const reloaded = make({ token: 'fake', theme: 'light' })
    const tools2 = storeTools({ auth: reloaded })
    expect(await part(tools2).adopt(journal)).toMatchObject({ adopted: ['auth:token'] })
    expect(reloaded.getState().token).toBe('fake')
    run(tools2, 'store.restore')
    expect(reloaded.getState().token).toBe('real')
    expect(typeof reloaded.getState().setTheme).toBe('function')
  })

  test('leaves a store the app changed since, and waits for one that is not hydrated', async () => {
    const auth = make({})
    const tools = storeTools({ auth })
    run(tools, 'store.set', 'auth', { token: 'fake' })
    const journal = part(tools).journal()
    const changed = storeTools({ auth: make({ token: 'app-token' }) })
    expect(await part(changed).adopt(journal)).toMatchObject({ changed: ['auth:token'] })
    const cold = storeTools({ auth: make({ token: 'fake' }, false) }, {})
    expect(await part(cold).adopt(journal)).toMatchObject({ retry: journal })
  })

  type Wide = Record<string, unknown> & { setX: () => void }
  const wide = (state: Record<string, unknown>, partialize?: (s: Wide) => unknown, hydrated = true) => {
    const store = createStore<Wide>()(() => ({ setX: () => {}, ...state }) as Wide)
    return Object.assign(store, {
      persist: {
        getOptions: () => ({ partialize }),
        hasHydrated: () => hydrated,
        onFinishHydration: () => () => {},
      },
    })
  }

  test('a key that is not JSON is not journaled and is named as not kept', async () => {
    const day = new Date(0)
    const auth = wide({ token: 'real', seen: new Set(['a']), day })
    const tools = storeTools({ auth })
    run(tools, 'store.set', 'auth', { token: 'fake', seen: new Set(['b']), day: new Date(5) })
    const journal = part(tools).journal()
    expect(journal).toEqual({
      auth: { original: { token: 'real' }, after: { token: 'fake' }, skipped: ['seen', 'day'] },
    })
    const reloaded = wide({ token: 'fake', seen: new Set(['b']), day: new Date(5) })
    const tools2 = storeTools({ auth: reloaded })
    expect(await part(tools2).adopt(journal)).toMatchObject({
      adopted: ['auth:token'],
      notKept: ['auth:seen', 'auth:day'],
    })
    run(tools2, 'store.restore')
    expect(reloaded.getState().token).toBe('real')
    expect((reloaded.getState().seen as Set<string>).has('b')).toBe(true)
  })

  test('restore writes only the keys the agent changed; a boot-time write to another key survives', async () => {
    const auth = wide({ token: 'real', launchCount: 1, seen: new Set(['a']) })
    const tools = storeTools({ auth })
    run(tools, 'store.set', 'auth', { token: 'fake' })
    const journal = part(tools).journal()
    const reloaded = wide({ token: 'fake', launchCount: 2, seen: new Set(['a']) })
    const seenBefore = reloaded.getState().seen
    const tools2 = storeTools({ auth: reloaded })
    expect(await part(tools2).adopt(journal)).toMatchObject({ adopted: ['auth:token'] })
    run(tools2, 'store.restore')
    expect(reloaded.getState().token).toBe('real')
    expect(reloaded.getState().launchCount).toBe(2)
    expect(reloaded.getState().seen).toBe(seenBefore)
  })

  test('journals only what partialize returns, mapped back only when the key is the same value', async () => {
    const keep = (s: Wide) => ({ token: s.token })
    const auth = wide({ token: 'real', theme: 'light' }, keep)
    const tools = storeTools({ auth })
    run(tools, 'store.set', 'auth', { token: 'fake', theme: 'dark' })
    expect(part(tools).journal()).toEqual({
      auth: { original: { token: 'real' }, after: { token: 'fake' } },
    })
  })

  test('a partialize that renames keys is refused and named', async () => {
    const rename = (s: Wide) => ({ saved: s.token })
    const auth = wide({ token: 'real' }, rename)
    const tools = storeTools({ auth })
    run(tools, 'store.set', 'auth', { token: 'fake' })
    const journal = part(tools).journal()
    expect(journal).toEqual({ auth: { original: {}, after: {}, skipped: ['saved'] } })
    const reloaded = wide({ token: 'fake' }, rename)
    const tools2 = storeTools({ auth: reloaded })
    expect(await part(tools2).adopt(journal)).toMatchObject({ adopted: [], notKept: ['auth:saved'] })
    run(tools2, 'store.restore')
    expect(reloaded.getState().token).toBe('fake')
  })
})

describe('round 4', () => {
  type W = Record<string, unknown> & { setX: () => void }
  const wide = (state: Record<string, unknown>, partialize?: (s: W) => unknown) => {
    const store = createStore<W>()(() => ({ setX: () => {}, ...state }) as W)
    return Object.assign(store, {
      persist: { getOptions: () => ({ partialize }), hasHydrated: () => true, onFinishHydration: () => () => {} },
    })
  }
  const part = (tools: Tools) =>
    tools['store.restore'] as { journal: () => unknown; adopt: (d: unknown) => Promise<unknown>; journalRev: () => number }

  test('redacted keys never enter the journal and are named as not kept', async () => {
    const auth = wide({ token: 'real-secret', user: { phone: '1', name: 'a' }, theme: 'light' })
    const tools = storeTools({ auth }, { redact: { auth: ['token', 'user.phone'] } })
    run(tools, 'store.set', 'auth', { token: 'fake', user: { phone: '2', name: 'b' }, theme: 'dark' })
    const journal = part(tools).journal()
    expect(JSON.stringify(journal)).not.toContain('real-secret')
    expect(JSON.stringify(journal)).not.toContain('"phone"')
    expect(journal).toEqual({
      auth: { original: { theme: 'light' }, after: { theme: 'dark' }, skipped: ['token', 'user'] },
    })
  })

  test('a redact hook also keeps its keys out of the journal', () => {
    const auth = wide({ token: 'real-secret' })
    const tools = storeTools({ auth }, { redact: (_s, path, v) => (path === 'token' ? '[x]' : v) })
    run(tools, 'store.set', 'auth', { token: 'fake' })
    expect(JSON.stringify(part(tools).journal())).not.toContain('real-secret')
  })

  test('restore after an adopt puts back only the adopted keys, not later app writes', async () => {
    const auth = wide({ token: 'real', cart: 0 })
    const tools = storeTools({ auth })
    run(tools, 'store.set', 'auth', { token: 'fake' })
    const journal = part(tools).journal()
    const reloaded = wide({ token: 'fake', cart: 0 })
    const tools2 = storeTools({ auth: reloaded })
    await part(tools2).adopt(journal)
    reloaded.setState({ cart: 3, launchCount: 2 })
    run(tools2, 'store.restore')
    expect(reloaded.getState().token).toBe('real')
    expect(reloaded.getState().cart).toBe(3)
    expect(reloaded.getState().launchCount).toBe(2)
  })

  test('a store.set after an adopt upgrades to a full snapshot that still returns the adopted key', async () => {
    const auth = wide({ token: 'real', cart: 0 })
    const tools = storeTools({ auth })
    run(tools, 'store.set', 'auth', { token: 'fake' })
    const journal = part(tools).journal()
    const reloaded = wide({ token: 'fake', cart: 0 })
    const tools2 = storeTools({ auth: reloaded })
    await part(tools2).adopt(journal)
    reloaded.setState({ cart: 3 })
    run(tools2, 'store.set', 'auth', { cart: 9 })
    run(tools2, 'store.restore')
    expect(reloaded.getState().token).toBe('real')
    expect(reloaded.getState().cart).toBe(3)
  })

  test('an original that was undefined is journaled as absent', async () => {
    const auth = wide({ token: undefined, cart: 0 })
    const tools = storeTools({ auth })
    run(tools, 'store.set', 'auth', { token: 'fake' })
    const journal = part(tools).journal()
    expect(journal).toEqual({ auth: { original: {}, after: { token: 'fake' } } })
    const reloaded = wide({ token: 'fake', cart: 0 })
    const tools2 = storeTools({ auth: reloaded })
    expect(await part(tools2).adopt(journal)).toMatchObject({ adopted: ['auth:token'] })
    run(tools2, 'store.restore')
    expect(reloaded.getState().token).toBeUndefined()
  })

  test('undefined properties inside a value do not stop it being journaled', () => {
    const auth = wide({ user: { name: 'a', nick: undefined } })
    const tools = storeTools({ auth })
    run(tools, 'store.set', 'auth', { user: { name: 'b', nick: undefined } })
    expect(part(tools).journal()).toEqual({ auth: { original: { user: { name: 'a' } }, after: { user: { name: 'b' } } } })
  })

  test('store.call bumps the journal revision after an async action settles', async () => {
    const auth = wide({ token: 'real' })
    const tools = storeTools({ auth })
    let during = -1
    auth.setState({
      login: async () => {
        await Promise.resolve()
        auth.setState({ token: 'fake' })
        during = part(tools).journalRev()
      },
    })
    await run(tools, 'store.call', 'auth', 'login')
    expect(part(tools).journalRev()).toBeGreaterThan(during)
  })
})
