import { describe, expect, test } from 'bun:test'
import { atom, createStore } from 'jotai'

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
  const atoms = { count: countAtom, user: userAtom, token: tokenAtom, double: doubleAtom, celsius: celsiusAtom, async: asyncAtom }
  return { store, atoms, countAtom, userAtom, tokenAtom }
}

describe('jotaiTools', () => {
  test('lists atoms with whether they can be set', async () => {
    const { store, atoms } = setup()
    expect(await run(jotaiTools(store, atoms), 'jotai.list')).toEqual({
      count: 'read-write',
      user: 'read-write',
      token: 'read-write',
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

  test('commit keeps one atom, or all', async () => {
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
    const tools = jotaiTools(store, atoms, { redact: { token: true, user: ['phone'] } })
    expect(await run(tools, 'jotai.get', 'token')).toBe('[redacted]')
    expect(await run(tools, 'jotai.get', 'user')).toEqual({ name: 'Ada', phone: '[redacted]' })
    expect(await run(tools, 'jotai.set', 'token', 'new')).toBe('[redacted]')
    await run(tools, 'jotai.set', 'user', { name: 'Bob', phone: '2' })
    expect(await pending(tools, true)).toEqual({
      token: { snapshot: '[redacted]', current: '[redacted]' },
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
})
