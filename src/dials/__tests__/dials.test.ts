import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// A minimal hook host: each "component" re-runs when a store it subscribed to changes.
type Comp = { fn: () => void; renders: number; cleanups: (() => void)[]; subs: unknown[] }
let current: Comp | undefined
const realReact = await import('react')
// Keep the other exports: bun shares module mocks across test files.
mock.module('react', () => ({
  ...realReact,
  default: realReact,
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    const comp = current!
    // Effects with deps run on mount only here; the dial hooks use stable deps.
    if (comp.renders === 1 || !deps) {
      const clean = fn()
      if (clean) comp.cleanups.push(clean)
    }
  },
  useSyncExternalStore: (sub: (cb: () => void) => () => void, get: () => unknown) => {
    const comp = current!
    comp.subs.push(sub)
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
const { resetHighlight } = await import('../highlight')
const { addOwner, ownersOf } = await import('../registry')
const { resetRegistry } = await import('../registry')
const noop = await import('../../noop/dials')

const unmount = (comp: Comp) => comp.cleanups.splice(0).forEach((c) => c())
const mount = (fn: () => void): Comp => {
  const comp: Comp = { fn, renders: 1, cleanups: [], subs: [] }
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
  resetHighlight()
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
  const tree = { color: { brand: '#0a0', accent: '#00f' }, space: { md: 12 } }
  const sets: [string, unknown][] = []
  beforeEach(() => {
    sets.length = 0
    tools = dialTools({ theme: { tokens: () => tree, set: (p, v) => void sets.push([p, v]) } })
  })

  test('dial.tokens returns the tree with labels, null without a theme', async () => {
    expect(await call('dial.tokens')).toEqual({ tokens: tree, labels: {} })
    tools = dialTools({ theme: { tokens: () => tree, labels: { color: 'Colours', 'color.brand': 'Leaf' } } })
    expect(await call('dial.tokens')).toEqual({ tokens: tree, labels: { color: 'Colours', 'color.brand': 'Leaf' } })
    resetRegistry()
    tools = dialTools()
    expect(await call('dial.tokens')).toBeNull()
  })

  test('token dial picks another path from the same group and returns its value', async () => {
    let v: string | number = ''
    mount(() => (v = dial.token('brand', 'color.brand', '#fff')))
    expect(v).toBe('#0a0')
    const [d] = (await call('dial.list')) as { type: string; tokenPath: string; value: string }[]
    expect(d).toMatchObject({ type: 'token', tokenPath: 'color.brand', value: 'color.brand', original: 'color.brand' })
    await call('dial.set', 'brand', 'color.accent')
    expect(v).toBe('#00f')
    expect(() => call('dial.set', 'brand', '#f00')).toThrow('color.brand, color.accent')
    await call('dial.restore')
    expect(v).toBe('#0a0')
    expect(sets).toEqual([])
  })

  test('unresolvable path returns the fallback', () => {
    let v: string | number = ''
    mount(() => (v = dial.token('x', 'color.nope', '#abc')))
    expect(v).toBe('#abc')
  })
})

describe('variant', () => {
  test('plain values: returns the picked one; list shows keys as options', async () => {
    let v = ''
    mount(() => (v = dial.variant('gap', { tight: 'a', roomy: 'b' }, 'tight')))
    expect(v).toBe('a')
    const [d] = (await call('dial.list')) as { type: string; options: string[]; value: string }[]
    expect(d).toMatchObject({ type: 'variant', options: ['tight', 'roomy'], value: 'tight' })
    await call('dial.set', 'gap', 'roomy')
    expect(v).toBe('b')
    expect(() => call('dial.set', 'gap', 'nope')).toThrow('"tight", "roomy"')
  })

  test('components: one stable host renders the picked component', async () => {
    const A = () => null
    const B = () => null
    let Host: (p: object) => unknown = () => null
    mount(() => (Host = dial.variant('card', { roomy: A, tiles: B }, 'roomy') as never))
    const first = Host
    let el: { type: unknown } | null = null
    mount(() => (el = Host({}) as never))
    expect(el!.type).toBe(A)
    await call('dial.set', 'card', 'tiles')
    expect(el!.type).toBe(B)
    mount(() => (Host = dial.variant('card', { roomy: A, tiles: B }, 'roomy') as never))
    expect(Host).toBe(first)
  })
})

describe('review fixes', () => {
  test('a held value is dropped once its dial takes it', async () => {
    await call('dial.apply', { later: 5 })
    const restore = def('dial.restore')
    expect(restore.pending!({ detail: true })).toEqual(['later'])
    mount(() => dial.number('later', 1))
    expect(restore.pending!({ detail: true })).toEqual(['later'])
    await call('dial.set', 'later', 1)
    expect(restore.pending!()).toBeFalsy()
  })

  test('highlight with an unknown id keeps the old outline and its timer', async () => {
    const f = { tag: 0, child: { tag: 5, stateNode: { getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }), checkVisibility: () => true }, child: null, sibling: null, return: null, memoizedProps: {} }, sibling: null, return: null, stateNode: null, memoizedProps: {} }
    const shared = (realReact as unknown as Record<string, { A: unknown }>)['__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE']!
    const prev = shared.A
    shared.A = { getOwner: () => f }
    mount(() => dial.number('n', 1))
    shared.A = prev
    await call('dial.highlight', 'n')
    const { highlighted } = await import('../highlight')
    expect(() => call('dial.highlight', 'missing')).toThrow('No dial')
    expect(highlighted()).toHaveLength(1)
    await call('dial.set', 'n', 2)
    await new Promise((r) => setTimeout(r, 10))
    expect(highlighted()).toHaveLength(1)
  })

  test('plain function variants are values, not components', async () => {
    const short = (n: number) => `${n}`
    const long = (n: number) => `${n}.00`
    let f: unknown
    mount(() => (f = dial.variant('fmt', { short, long }, 'short')))
    expect(f).toBe(short)
    await call('dial.set', 'fmt', 'long')
    expect(f).toBe(long)
  })

  test('an unknown default behaves the same in dev and release', () => {
    let plain: unknown = 'unset'
    mount(() => (plain = dial.variant('a', { x: 1 }, 'nope')))
    expect(plain).toBeUndefined()
    expect(noop.dial.variant('a', { x: 1 }, 'nope')).toBeUndefined()
    const A = () => null
    let Dev: unknown
    mount(() => (Dev = dial.variant('c', { A }, 'nope')))
    const Rel = noop.dial.variant('c', { A }, 'nope') as (p: object) => unknown
    expect(typeof Dev).toBe('function')
    expect((Dev as (p: object) => unknown)({})).toBeNull()
    expect(Rel({})).toBeNull()
  })

  test('a variant added by a later registration is accepted', async () => {
    mount(() => dial.variant('v', { a: 'A' }, 'a'))
    mount(() => dial.variant('v', { a: 'A', b: 'B' }, 'a'))
    await call('dial.set', 'v', 'b')
    const [d] = (await call('dial.list')) as { options: string[] }[]
    expect(d!.options).toEqual(['a', 'b'])
  })

  test('later registrations refresh number constraints', async () => {
    mount(() => dial.number('n', 1, { max: 3 }))
    mount(() => dial.number('n', 1, { max: 10 }))
    await call('dial.set', 'n', 8)
  })
})

describe('subscribe', () => {
  test('the same subscribe function is passed on every render', async () => {
    const c = mount(() => dial.number('n', 1))
    await call('dial.set', 'n', 2)
    expect(c.subs.length).toBe(2)
    expect(c.subs[0]).toBe(c.subs[1])
  })
})

describe('owners, rects and highlight', () => {
  const internals = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'
  const box = (x: number, width: number) => ({
    tag: 5,
    stateNode: { getBoundingClientRect: () => ({ x, y: 10, width, height: 20 }), checkVisibility: () => true },
    child: null,
    sibling: null,
    return: null,
    memoizedProps: {},
  })
  // A component fiber whose first host child is a box.
  const comp = (x: number, width = 50) => ({ tag: 0, child: box(x, width), sibling: null, return: null, stateNode: null, memoizedProps: {} })
  const withOwner = (fiber: object | null, fn: () => void) => {
    const shared = (realReact as unknown as Record<string, { A: unknown }>)[internals]!
    const prev = shared.A
    shared.A = fiber ? { getOwner: () => fiber } : null
    try {
      return mount(fn)
    } finally {
      shared.A = prev
    }
  }

  test('a reading component is tracked while mounted and dropped on unmount', async () => {
    const f = comp(5)
    const c = withOwner(f, () => dial.number('n', 1))
    expect(ownersOf('n')).toEqual([f])
    unmount(c)
    expect(ownersOf('n')).toEqual([])
  })

  test('rects measures the first host view of each owner', async () => {
    withOwner(comp(5), () => dial.number('n', 1))
    withOwner(comp(100, 30), () => dial.number('n', 1))
    const r = await call('dial.rects', 'n')
    expect(r).toMatchObject({
      rects: [
        { x: 5, y: 10, width: 50, height: 20 },
        { x: 100, y: 10, width: 30, height: 20 },
      ],
      scale: 1,
    })
  })

  test('fails soft: no owner means no rects; unmeasurable owners are skipped', async () => {
    withOwner(null, () => dial.number('n', 1))
    expect(((await call('dial.rects', 'n')) as { rects: unknown[] }).rects).toEqual([])
    addOwner('n', { tag: 0, child: null })
    expect(((await call('dial.rects', 'n')) as { rects: unknown[] }).rects).toEqual([])
    expect(() => call('dial.rects', 'missing')).toThrow('No dial')
  })

  test('highlight returns the rects, follows a value change and clears with null', async () => {
    let x = 5
    const f = { tag: 0, child: { ...box(0, 50), stateNode: { getBoundingClientRect: () => ({ x, y: 10, width: 50, height: 20 }), checkVisibility: () => true } }, sibling: null, return: null, stateNode: null, memoizedProps: {} }
    withOwner(f, () => dial.number('n', 1))
    expect(await call('dial.highlight', 'n')).toEqual({ rects: [{ x: 5, y: 10, width: 50, height: 20 }] })
    x = 40
    await call('dial.set', 'n', 2)
    await new Promise((r) => setTimeout(r, 10))
    const { highlighted } = await import('../highlight')
    expect(highlighted()[0]!.x).toBe(40)
    expect(await call('dial.highlight', null)).toEqual({ rects: [] })
    expect(highlighted()).toEqual([])
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
    expect(noop.dial.variant('a', { x: 1, y: 2 }, 'y')).toBe(2)
    expect(noop.DialsOverlay()).toBeNull()
    expect(noop.dialTools()).toEqual({})
    expect(noop.useDials()).toEqual({})
  })
})

describe('outline brackets', () => {
  const host = (id: string, meta?: { outline?: { color: string } }) => {
    const f = { tag: 0, child: { tag: 5, stateNode: { getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 60 }), checkVisibility: () => true }, child: null, sibling: null, return: null, memoizedProps: {} }, sibling: null, return: null, stateNode: null, memoizedProps: {} }
    const shared = (realReact as unknown as Record<string, { A: unknown }>)['__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE']!
    const prev = shared.A
    shared.A = { getOwner: () => f }
    mount(() => dial.number(id, 1, meta))
    shared.A = prev
  }
  const colors = (node: unknown): string[] => {
    const out: string[] = []
    const walk = (n: unknown) => {
      const el = n as { props?: { style?: { borderColor?: string }; children?: unknown }; type?: unknown }
      if (!el || typeof el !== 'object') return
      if (el.props?.style?.borderColor) out.push(el.props.style.borderColor)
      for (const c of [el.props?.children].flat()) walk(c)
    }
    walk(node)
    return out
  }
  const render = async () => {
    const { drawOutline } = await import('../overlay')
    const { outlineView } = await import('../highlight')
    return drawOutline('View' as never, outlineView()) as unknown
  }

  test('draws four brackets in the default colour, each with a dark edge', async () => {
    host('n')
    await call('dial.highlight', 'n')
    const cs = colors(await render())
    expect(cs.filter((c) => c === '#3D7BFF')).toHaveLength(4)
    expect(cs.filter((c) => c.startsWith('rgba'))).toHaveLength(4)
  })

  test('colour order: dial > session > app > default', async () => {
    const { setOutlineColor } = await import('../highlight')
    host('n')
    host('own', { outline: { color: '#111111' } })
    const pick = async (id: string, session?: string) => {
      await call('dial.highlight', id, session ? { color: session } : undefined)
      return colors(await render()).find((c) => !c.startsWith('rgba'))
    }
    expect(await pick('n')).toBe('#3D7BFF')
    setOutlineColor('#222222')
    expect(await pick('n')).toBe('#222222')
    expect(await pick('n', '#333333')).toBe('#333333')
    expect(await pick('own', '#333333')).toBe('#111111')
  })

  test('dial.highlight(id) with one arg works; hides on a change and shows 350 ms after the last', async () => {
    host('n')
    await call('dial.highlight', 'n')
    expect(await render()).not.toBeNull()
    await call('dial.set', 'n', 2)
    expect(await render()).toBeNull()
    await new Promise((r) => setTimeout(r, 200))
    await call('dial.set', 'n', 3)
    await new Promise((r) => setTimeout(r, 200))
    expect(await render()).toBeNull()
    await new Promise((r) => setTimeout(r, 250))
    expect(await render()).not.toBeNull()
  })
})
