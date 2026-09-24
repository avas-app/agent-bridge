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
})
