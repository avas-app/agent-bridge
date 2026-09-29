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
})
