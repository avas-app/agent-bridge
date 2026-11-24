import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// A minimal hook host: each "component" re-runs when a store it subscribed to changes.
type Comp = { fn: () => void; renders: number }
let current: Comp | undefined
const realReact = await import('react')
// Keep the other exports: bun shares module mocks across test files.
mock.module('react', () => ({
  ...realReact,
  default: realReact,
  useSyncExternalStore: (sub: (cb: () => void) => () => void, get: () => unknown) => {
    const comp = current!
    sub(() => {
      const prev = current
      current = comp
      comp.renders++
      comp.fn()
      current = prev
    })
    return get()
  },
}))

const { dial, dialTools } = await import('../index')
const { resetRegistry } = await import('../registry')
const noop = await import('../../noop/dials')

const mount = (fn: () => void): Comp => {
  const comp: Comp = { fn, renders: 1 }
  current = comp
  fn()
  return comp
}
let tools: ReturnType<typeof dialTools>
const call = (name: string, ...args: unknown[]) => {
  const t = tools[name]!
  return (typeof t === 'function' ? t : t.run)(...args)
}
const def = (name: string) => tools[name] as Exclude<(typeof tools)[string], (...a: never[]) => unknown>

beforeEach(() => {
  resetRegistry()
  tools = dialTools()
})
afterEach(() => {
  current = undefined
})

describe('registry', () => {
  test('first registration fixes original; re-registration keeps the value', async () => {
    let seen = ''
    mount(() => (seen = dial.color('accent', '#112233')))
    await call('dial.set', 'accent', '#ff0000')
    expect(seen).toBe('#ff0000')
    // Fast Refresh: the component runs again with a new default
    let again = ''
    mount(() => (again = dial.color('accent', '#000000')))
    expect(again).toBe('#ff0000')
    const [d] = (await call('dial.list')) as { original: string }[]
    expect(d!.original).toBe('#112233')
  })

  test('only the component that reads the changed dial re-renders', async () => {
    let a = 0
    let b = 0
    const ca = mount(() => (a = dial.number('a', 1)))
    const cb = mount(() => (b = dial.number('b', 2)))
    await call('dial.set', 'a', 5)
    expect([a, b]).toEqual([5, 2])
    expect(ca.renders).toBe(2)
    expect(cb.renders).toBe(1)
  })
})

describe('validation', () => {
  beforeEach(() => {
    mount(() => {
      dial.number('n', 5, { min: 0, max: 10 })
      dial.enum('e', 'a', ['a', 'b'])
      dial.color('c', '#fff')
      dial.boolean('t', false)
      dial.text('s', 'hi')
    })
  })
  test('errors list allowed values', async () => {
    expect(() => call('dial.set', 'e', 'z')).toThrow(/"a", "b"/)
    expect(() => call('dial.set', 'n', 11)).toThrow(/from 0 to 10/)
    expect(() => call('dial.set', 'n', 'x')).toThrow(/finite number/)
    expect(() => call('dial.set', 'c', '12')).toThrow(/#rrggbb/)
    expect(() => call('dial.set', 't', 'yes')).toThrow(/true, false/)
    expect(() => call('dial.set', 's', 3)).toThrow(/string/)
    expect(() => call('dial.set', 'nope', 3)).toThrow(/No dial "nope"/)
  })
  test('valid values are returned as the Dial', async () => {
    const d = (await call('dial.set', 'n', 7)) as { value: number; min: number; renders: number }
    expect(d).toMatchObject({ value: 7, min: 0 })
  })
})

describe('apply, reset, restore', () => {
  test('apply keeps unknown ids and gives them to the dial when it mounts', async () => {
    mount(() => dial.number('known', 1))
    const r = await call('dial.apply', { known: 4, later: 'x' })
    expect(r).toEqual({ applied: ['known'], unknown: ['later'] })
    let seen = ''
    mount(() => (seen = dial.text('later', 'orig')))
    expect(seen).toBe('x')
  })

  test('apply reports invalid values without failing the rest', async () => {
    mount(() => {
      dial.number('n', 1, { max: 3 })
      dial.number('m', 1)
    })
    const r = (await call('dial.apply', { n: 9, m: 2 })) as { applied: string[]; invalid: unknown[] }
    expect(r.applied).toEqual(['m'])
    expect(r.invalid).toHaveLength(1)
  })

  test('reset one and all', async () => {
    let n = 0
    let m = 0
    mount(() => {
      n = dial.number('n', 1)
      m = dial.number('m', 2)
    })
    await call('dial.set', 'n', 9)
    await call('dial.set', 'm', 8)
    await call('dial.reset', 'n')
    expect([n, m]).toEqual([1, 8])
    await call('dial.reset')
    expect([n, m]).toEqual([1, 2])
  })

  test('restore puts values back and pending reports what is changed', async () => {
    let n = 0
    mount(() => (n = dial.number('n', 1)))
    const restore = def('dial.restore')
    expect(restore.pending!()).toBeFalsy()
    await call('dial.set', 'n', 9)
    expect(restore.pending!()).toBe(true)
    expect(restore.pending!({ detail: true })).toEqual(['n'])
    await call('dial.restore')
    expect(n).toBe(1)
    expect(restore.pending!()).toBeFalsy()
  })
})

describe('tokens', () => {
  const tree = { color: { brand: '#0a0' }, space: { md: 12 } }
  const sets: [string, unknown][] = []
  beforeEach(() => {
    sets.length = 0
    tools = dialTools({ theme: { tokens: () => tree, set: (p, v) => void sets.push([p, v]) } })
  })

  test('dial.tokens returns the tree, null without a theme', async () => {
    expect(await call('dial.tokens')).toEqual(tree)
    resetRegistry()
    tools = dialTools()
    expect(await call('dial.tokens')).toBeNull()
  })

  test('token dial resolves the path, records it, writes through the theme', async () => {
    let v: string | number = ''
    mount(() => (v = dial.token('brand', 'color.brand', '#fff')))
    expect(v).toBe('#0a0')
    const [d] = (await call('dial.list')) as { type: string; tokenPath: string }[]
    expect(d).toMatchObject({ type: 'token', tokenPath: 'color.brand' })
    await call('dial.set', 'brand', '#f00')
    expect(sets).toEqual([['color.brand', '#f00']])
    expect(v).toBe('#f00')
    await call('dial.restore')
    expect(sets.at(-1)).toEqual(['color.brand', '#0a0'])
  })

  test('unresolvable path returns the fallback', () => {
    let v: string | number = ''
    mount(() => (v = dial.token('x', 'color.nope', '#abc')))
    expect(v).toBe('#abc')
  })
})

describe('release stub', () => {
  test('every dial returns its default and tools are empty', () => {
    expect(noop.dial.color('a', '#fff')).toBe('#fff')
    expect(noop.dial.number('a', 3)).toBe(3)
    expect(noop.dial.enum('a', 'x', ['x', 'y'])).toBe('x')
    expect(noop.dial.boolean('a', true)).toBe(true)
    expect(noop.dial.text('a', 't')).toBe('t')
    expect(noop.dial.token('a', 'p.q', '#123')).toBe('#123')
    expect(noop.dialTools()).toEqual({})
    expect(noop.useDials()).toEqual({})
  })
})
