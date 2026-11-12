import { describe, expect, spyOn, test } from 'bun:test'
import { atom, createStore } from 'jotai'
import { atomWithReducer, atomWithStorage, createJSONStorage } from 'jotai/utils'

import type { ToolFn, Tools } from '../../runtime/types'
import { jotaiTools } from '../jotai'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}
const fails = (fn: () => unknown) => expect((async () => fn())()).rejects
const pending = (tools: Tools, detail?: boolean) => {
  const t = tools['jotai.restore']
  return typeof t === 'object' && t.pending ? t.pending({ detail }) : undefined
}

function setup() {
  const store = createStore()
  const countAtom = atom(0)
  const userAtom = atom({ name: 'Ada', phone: '555' })
  const tokenAtom = atom<string | null>('secret')
  const doubleAtom = atom((get) => get(countAtom) * 2)
  const celsiusAtom = atom(
    (get) => (get(countAtom) - 32) / 2,
    (_get, set, c: number) => set(countAtom, c * 2 + 32),
  )
  const asyncAtom = atom(async (get) => get(countAtom) + 1)
  const atoms = { count: countAtom, user: userAtom, auth: tokenAtom, double: doubleAtom, celsius: celsiusAtom, async: asyncAtom }
  return { store, atoms, countAtom, userAtom, tokenAtom }
}

describe('jotaiTools', () => {
  test('lists atoms with whether they can be set', async () => {
    const { store, atoms } = setup()
    expect(await run(jotaiTools(store, atoms), 'jotai.list')).toEqual({
      count: 'read-write',
      user: 'read-write',
      auth: 'read-write',
      double: 'read-only',
      celsius: 'read-write',
      async: 'read-only',
    })
  })

  test('get reads values, paths and derived and async atoms', async () => {
    const { store, atoms } = setup()
    const tools = jotaiTools(store, atoms)
    expect(await run(tools, 'jotai.get', 'count')).toBe(0)
    expect(await run(tools, 'jotai.get', 'user', 'name')).toBe('Ada')
    expect(await run(tools, 'jotai.get', 'user', { keys: true })).toEqual({ name: 'string', phone: 'string' })
    expect(await run(tools, 'jotai.get', 'async')).toBe(1)
    await fails(() => run(tools, 'jotai.get', 'nope')).toThrow(/Unknown atom "nope"/)
  })

  test('set writes a writable atom and returns the new value; read-only atoms are refused', async () => {
    const { store, atoms, countAtom } = setup()
    const tools = jotaiTools(store, atoms)
    expect(await run(tools, 'jotai.set', 'count', 5)).toBe(5)
    expect(store.get(countAtom)).toBe(5)
    expect(await run(tools, 'jotai.get', 'double')).toBe(10)
    await fails(() => run(tools, 'jotai.set', 'double', 1)).toThrow(/read-only/)
    expect(await pending(tools)).toBe(true)
  })

  test('restore puts back the value from before the first set, atom by atom', async () => {
    const { store, atoms, countAtom, userAtom } = setup()
    const tools = jotaiTools(store, atoms)
    expect(await pending(tools)).toBe(false)
    await run(tools, 'jotai.set', 'count', 1)
    await run(tools, 'jotai.set', 'count', 2)
    await run(tools, 'jotai.set', 'user', { name: 'Bob', phone: '1' })
    expect(await pending(tools, true)).toEqual({
      count: { snapshot: 0, current: 2 },
      user: { snapshot: { name: 'Ada', phone: '555' }, current: { name: 'Bob', phone: '1' } },
    })
    expect((await run(tools, 'jotai.restore')) as string[]).toEqual(['user', 'count'])
    expect(store.get(countAtom)).toBe(0)
    expect(store.get(userAtom)).toEqual({ name: 'Ada', phone: '555' })
    expect(await pending(tools)).toBe(false)
  })

  test('a writable derived atom is restored through its own write', async () => {
    const { store, atoms, countAtom } = setup()
    const tools = jotaiTools(store, atoms)
    await run(tools, 'jotai.set', 'celsius', 100)
    expect(store.get(countAtom)).toBe(232)
    await run(tools, 'jotai.restore')
    expect(store.get(countAtom)).toBe(0)
  })

  test('snapshot survives tools rebuilt on every render', async () => {
    const { store, atoms, countAtom } = setup()
    await run(jotaiTools(store, atoms), 'jotai.set', 'count', 9)
    await run(jotaiTools(store, { ...atoms }), 'jotai.restore')
    expect(store.get(countAtom)).toBe(0)
  })

  test('commit keeps one atom', async () => {
    const { store, atoms, countAtom } = setup()
    const tools = jotaiTools(store, atoms)
    await run(tools, 'jotai.set', 'count', 3)
    await run(tools, 'jotai.set', 'user', { name: 'x', phone: 'y' })
    expect(await run(tools, 'jotai.commit', 'count')).toEqual({ atom: 'count', committed: true })
    expect(await run(tools, 'jotai.commit', 'count')).toEqual({ atom: 'count', committed: false })
    expect(await run(tools, 'jotai.restore')).toEqual(['user'])
    expect(store.get(countAtom)).toBe(3)
  })

  test('redact hides whole atoms and paths in get, set and pending', async () => {
    const { store, atoms } = setup()
    const tools = jotaiTools(store, atoms, { redact: { auth: true, user: ['phone'] } })
    expect(await run(tools, 'jotai.get', 'auth')).toBe('[redacted]')
    expect(await run(tools, 'jotai.get', 'user')).toEqual({ name: 'Ada', phone: '[redacted]' })
    expect(await run(tools, 'jotai.set', 'auth', 'new')).toBe('[redacted]')
    await run(tools, 'jotai.set', 'user', { name: 'Bob', phone: '2' })
    expect(await pending(tools, true)).toEqual({
      auth: { snapshot: '[redacted]', current: '[redacted]' },
      user: {
        snapshot: { name: 'Ada', phone: '[redacted]' },
        current: { name: 'Bob', phone: '[redacted]' },
      },
    })
  })

  test('a failing restore of one atom does not stop the others, and is reported', async () => {
    const { store, atoms, countAtom } = setup()
    const tools = jotaiTools(store, atoms)
    await run(tools, 'jotai.set', 'count', 4)
    await run(tools, 'jotai.set', 'user', { name: 'x', phone: 'y' })
    const orig = store.set
    store.set = ((a: unknown, ...rest: unknown[]) => {
      if (a === atoms.user) throw new Error('boom')
      return (orig as (...x: unknown[]) => unknown)(a, ...rest)
    }) as typeof store.set
    await fails(() => run(tools, 'jotai.restore')).toThrow(/user/)
    expect(store.get(countAtom)).toBe(0)
    store.set = orig
    expect(await run(tools, 'jotai.restore')).toEqual(['user'])
  })

  test('restore puts back a stored atomWithStorage value, not its initial value', async () => {
    const mem = new Map<string, string>([['k', JSON.stringify('STORED')]])
    const storage = createJSONStorage<string>(() => ({
      getItem: (key) => mem.get(key) ?? null,
      setItem: (key, v) => void mem.set(key, v),
      removeItem: (key) => void mem.delete(key),
    }))
    const stored = atomWithStorage('k', 'INIT', storage)
    const store = createStore()
    const tools = jotaiTools(store, { stored })
    await run(tools, 'jotai.set', 'stored', 'AGENT')
    expect(mem.get('k')).toBe(JSON.stringify('AGENT'))
    await run(tools, 'jotai.restore')
    expect(store.get(stored)).toBe('STORED')
    expect(mem.get('k')).toBe(JSON.stringify('STORED'))
  })

  test('an action atom is refused, and nothing stays pending', async () => {
    const { store, atoms } = setup()
    const calls: unknown[] = []
    const logout = atom(null, (_get, _set, arg: unknown) => void calls.push(arg))
    const tools = jotaiTools(store, { ...atoms, logout })
    await fails(() => run(tools, 'jotai.set', 'logout', 5)).toThrow(/action|did not take/)
    expect(await pending(tools)).toBe(false)
    await run(tools, 'jotai.restore')
    expect(calls).toEqual([5])
  })

  test('a reducer atom whose value is not the one sent is refused', async () => {
    const store = createStore()
    const r = atomWithReducer(10, (prev: number, action: number) => prev + action)
    const tools = jotaiTools(store, { r })
    await fails(() => run(tools, 'jotai.set', 'r', 3)).toThrow(/did not take/)
    expect(await pending(tools)).toBe(false)
  })

  test('a writable async atom snapshots its value, not a Promise', async () => {
    const store = createStore()
    const base = atom(1)
    const w = atom(async (get) => get(base), (_get, set, v: number) => set(base, v))
    const tools = jotaiTools(store, { w })
    await run(tools, 'jotai.set', 'w', 7)
    expect(store.get(base)).toBe(7)
    await run(tools, 'jotai.restore')
    expect(store.get(base)).toBe(1)
  })

  test('restore skips an atom the app changed since, and says so', async () => {
    const { store, atoms, countAtom } = setup()
    const tools = jotaiTools(store, atoms)
    await run(tools, 'jotai.set', 'count', 2)
    store.set(countAtom, 99)
    expect(await run(tools, 'jotai.restore')).toEqual({ restored: [], skipped: ['count'] })
    expect(store.get(countAtom)).toBe(99)
    expect(await pending(tools)).toBe(false)
  })

  test('a restore write that does not take is reported, and the snapshot stays', async () => {
    const store = createStore()
    const raw = atom(0)
    let locked = false
    const a = atom((get) => get(raw), (_get, set, v: number) => void (locked || set(raw, v)))
    const tools = jotaiTools(store, { a })
    await run(tools, 'jotai.set', 'a', 5)
    locked = true
    await fails(() => run(tools, 'jotai.restore')).toThrow(/Could not restore a/)
    expect(await pending(tools)).toBe(true)
    locked = false
    expect(await run(tools, 'jotai.restore')).toEqual(['a'])
    expect(store.get(raw)).toBe(0)
  })

  test('snapshots are kept by name, so a renamed or removed atom is reported by name', async () => {
    const { store, atoms } = setup()
    await run(jotaiTools(store, atoms), 'jotai.set', 'count', 2)
    const { count: _gone, ...rest } = atoms
    const tools = jotaiTools(store, rest)
    expect(Object.keys((await pending(tools, true)) as object)).toEqual(['count'])
    await fails(() => run(tools, 'jotai.restore')).toThrow(/count/)
  })

  test('errors name the jotai tool, and redact keys that match no atom are warned about once', async () => {
    const { store, atoms } = setup()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const tools = jotaiTools(store, atoms, { redact: { authh: true } })
    jotaiTools(store, atoms, { redact: { authh: true } })
    await fails(() => run(tools, 'jotai.get', 'user', { bogus: true })).toThrow(/jotai\.get option/)
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('authh'))).toHaveLength(1)
    warn.mockRestore()
  })
})
