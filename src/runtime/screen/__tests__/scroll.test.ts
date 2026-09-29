import { describe, expect, test } from 'bun:test'

import { createScreen } from '..'
import type { Fiber, Rect } from '../../find-text-core'
import { WINDOW, composite, host, pressable, rnText, textInput, tree } from './fake-tree'

// A ScrollView 400x600 at y=100 over 2000 points of content. Items sit at a
// content y; their window y moves with the offset, like the real thing.
function setup(extra: Record<string, unknown> = {}, list: Record<string, unknown> = {}, rootProps: Record<string, unknown> = {}) {
  const state = { offset: 0, calls: [] as unknown[][] }
  const live = (props: Record<string, unknown>, rect: () => Rect): Fiber => {
    const f = host(props)
    f.stateNode = { getBoundingClientRect: rect, checkVisibility: () => true }
    return f
  }
  const item = (content: Fiber, y: number) => {
    // Position the item's host by content y.
    const found: Fiber[] = []
    const visit = (f: Fiber | null) => {
      for (; f; f = f.sibling) {
        if (f.tag === 5) found.push(f)
        visit(f.child)
      }
    }
    visit(content)
    for (const h of found)
      h.stateNode = {
        getBoundingClientRect: () => ({ x: 0, y: 100 + y - state.offset, width: 200, height: 40 }),
        checkVisibility: () => true,
      }
    return content
  }
  // A FlatList over a ScrollView: the list has scrollToEnd, the ScrollView scrollTo.
  const scrollView = {
    scrollTo: (o: unknown) => {
      state.calls.push(['scrollTo', o])
      state.offset = (o as { y: number }).y
    },
  }
  const flatList = {
    scrollToOffset: () => state.calls.push(['scrollToOffset']),
    scrollToEnd: () => {
      state.calls.push(['scrollToEnd'])
      state.offset = 1400
    },
  }
  const content = tree(
    live({}, () => ({ x: 0, y: 100 - state.offset, width: 400, height: 2000 })),
    item(rnText('Top'), 20),
    item(
      pressable({ onPress: () => state.calls.push(['press']), testID: 'later' }, rnText('Later')),
      900,
    ),
    item(textInput({ onChangeText: (t: string) => state.calls.push(['fill', t]), placeholder: 'Notes', value: '' }), 1500),
  )
  const scroller = tree(
    { ...composite({ testID: 'list', ...extra, ...list }), tag: 1, stateNode: flatList },
    tree({ ...composite(), tag: 1, stateNode: scrollView }, tree(live({}, () => ({ x: 0, y: 100, width: 400, height: 600 })), content)),
  )
  const root = tree(host(rootProps), rnText('Header'), scroller)
  const screen = createScreen({ roots: () => [root], window: () => WINDOW })
  return { screen, state }
}

describe('scroll', () => {
  test('to an off-screen element: centres it and reports it on screen', async () => {
    const { screen, state } = setup()
    expect(screen.snapshot().elements.map((e) => e.text ?? e.placeholder)).not.toContain('Notes')
    const result = await screen.scroll('Notes')
    expect(state.calls).toEqual([['scrollTo', expect.objectContaining({ y: 1220, animated: false })]])
    expect(result).toMatchObject({ offset: 1220, max: 1400, onScreen: true, element: { placeholder: 'Notes' } })
  })

  test('to an element already in view does nothing', async () => {
    const { screen, state } = setup()
    await screen.scroll('Top')
    expect(state.calls).toEqual([])
  })

  test('{to}, {toEnd}, {toStart} and {by}, within a named scrollable', async () => {
    const { screen, state } = setup()
    expect((await screen.scroll({ to: 'Later' })).onScreen).toBe(true)
    expect(state.offset).toBe(620)
    await screen.scroll({ toEnd: true })
    expect(state.calls.at(-1)).toEqual(['scrollToEnd'])
    expect(state.offset).toBe(1400)
    expect((await screen.scroll({ by: -400 }, { within: 'list' })).offset).toBe(1000)
    expect((await screen.scroll({ by: 5000 })).offset).toBe(1400)
    expect((await screen.scroll({ toStart: true })).offset).toBe(0)
  })

  test('press and fill with scroll:true bring an off-screen match into view first', async () => {
    const { screen, state } = setup()
    await expect(screen.fill('Notes', 'hi')).rejects.toThrow(/not on screen.*scroll:true/)
    await expect(screen.press('Later')).rejects.toThrow(/not on screen/)
    expect(state.calls).toEqual([])
    await screen.press('Later', { scroll: true })
    await screen.fill('Notes', 'hi', { scroll: true })
    expect(state.calls.map((c) => c[0])).toEqual(['scrollTo', 'press', 'scrollTo', 'fill'])
  })

  test('errors: unknown shapes, no scrollable, elements outside one', async () => {
    const { screen } = setup()
    await expect(screen.scroll({ by: 'x' } as never)).rejects.toThrow(/number of points/)
    await expect(screen.scroll({ toEnd: true, by: 1 } as never)).rejects.toThrow(/one of/)
    await expect(screen.scroll('Header')).rejects.toThrow(/not inside a scrollable/)
    const bare = createScreen({ roots: () => [tree(host(), rnText('x'))], window: () => WINDOW })
    await expect(bare.scroll({ toEnd: true })).rejects.toThrow(/No scrollable on screen/)
  })

  test('a scrollable on a hidden screen is not the main one', async () => {
    const { screen } = setup({}, {}, { 'aria-hidden': true })
    await expect(screen.scroll({ toEnd: true })).rejects.toThrow(/No scrollable on screen/)
  })

  test('DOM-like scroll containers scroll through scrollTop', async () => {
    const dom = { scrollTop: 0, scrollHeight: 2000, clientHeight: 600, scrollLeft: 0, scrollWidth: 400, clientWidth: 400 }
    const el = host({ testID: 'pane' })
    el.stateNode = {
      ...dom,
      getBoundingClientRect: () => ({ x: 0, y: 100, width: 400, height: 600 }),
      checkVisibility: () => true,
      scrollTo(this: { scrollTop: number }, o: { top: number }) {
        this.scrollTop = o.top
      },
    }
    const root = tree(host(), tree(el, rnText('Row')))
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    expect(await screen.scroll({ by: 300 })).toMatchObject({ offset: 300, max: 1400 })
  })
})

describe('refresh', () => {
  test('calls the RefreshControl onRefresh of the main scrollable, or of a target', async () => {
    let refreshed = 0
    const control = { props: { onRefresh: () => (refreshed += 1), refreshing: false } }
    const { screen } = setup({ refreshControl: control })
    expect(await screen.refresh()).toEqual({ refreshed: true })
    expect(await screen.refresh('Later')).toEqual({ refreshed: true })
    expect(refreshed).toBe(2)
  })

  test('a list with its own onRefresh prop', async () => {
    let refreshed = 0
    const { screen } = setup({ onRefresh: () => (refreshed += 1) })
    await screen.refresh({ testID: 'list' })
    expect(refreshed).toBe(1)
  })

  test('says so when there is nothing to refresh', async () => {
    const { screen } = setup()
    await expect(screen.refresh()).rejects.toThrow(/No scrollable on screen has a RefreshControl/)
    await expect(screen.refresh('Later')).rejects.toThrow(/no RefreshControl/)
  })
})

// A generic scroller over `size` points of content: item positions are along
// the scroll axis, and window rects follow the offset (mirrored when inverted).
type Item = { at: number; size?: number; make: () => Fiber }
function scroller(
  view: () => Rect,
  size: number,
  items: Item[],
  opts: {
    horizontal?: boolean
    inverted?: boolean
    props?: Record<string, unknown>
    android?: boolean
    lateMs?: number
  } = {},
) {
  const state = { offset: 0, calls: [] as number[] }
  const h = !!opts.horizontal
  const start = () => (h ? view().x : view().y)
  const extent = () => (h ? view().width : view().height)
  const rectOf = (pos: number, len: number, cross: Rect): Rect => {
    const axis = opts.inverted
      ? start() + extent() - size + state.offset + (size - pos - len)
      : start() + pos - state.offset
    return h ? { ...cross, x: axis, width: len } : { ...cross, y: axis, height: len }
  }
  const at = (getRect: () => Rect, type?: string): Fiber => {
    const f = host()
    f.type = type
    f.stateNode = { getBoundingClientRect: getRect, checkVisibility: () => true, live: true }
    return f
  }
  const kids = items.map((item) => {
    const fiber = item.make()
    const visit = (f: Fiber | null) => {
      for (; f; f = f.sibling) {
        if (f.tag === 5 && !(f.stateNode as { live?: boolean } | null)?.live)
          f.stateNode = {
            getBoundingClientRect: () => rectOf(item.at, item.size ?? 40, { ...view(), width: 100, height: 40 }),
            checkVisibility: () => true,
            live: true,
          }
        visit(f.child)
      }
    }
    visit(fiber)
    return fiber
  })
  const content = tree(at(() => rectOf(0, size, view())), ...kids)
  const scrollHost = tree(at(view, opts.android ? 'RCTScrollView' : undefined), content)
  const top = opts.android ? tree(at(view, 'AndroidSwipeRefreshLayout'), scrollHost) : scrollHost
  const instance = {
    scrollTo: (o: { x: number; y: number }) => {
      const to = h ? o.x : o.y
      state.calls.push(to)
      if (opts.lateMs) setTimeout(() => (state.offset = to), opts.lateMs)
      else state.offset = to
    },
  }
  const fiber = tree(
    { ...composite({ horizontal: h, ...opts.props }), tag: 1, stateNode: instance },
    top,
  )
  return { fiber, state }
}

const VIEW = () => ({ x: 0, y: 100, width: 400, height: 600 })
const field = (label: string) => () => rnText(label)
const roots = (...children: Fiber[]) => {
  const root = tree(host(), ...children)
  return createScreen({ roots: () => [root], window: () => WINDOW })
}

describe('scroll hosts and timing', () => {
  test('Android: a refresh layout around the ScrollView is not the content', async () => {
    const list = scroller(VIEW, 2000, [{ at: 1500, make: field('Deep') }], {
      android: true,
      props: { refreshControl: { props: { onRefresh: () => {} } } },
    })
    const screen = roots(list.fiber)
    const result = await screen.scroll('Deep')
    expect(result).toMatchObject({ offset: 1220, max: 1400, onScreen: true })
    expect(await screen.scroll({ by: -220 })).toMatchObject({ offset: 1000 })
    list.state.offset = 0
    await screen.press('Deep', { scroll: true }).catch((e) => expect(String(e)).toMatch(/no onPress/))
    expect(list.state.offset).toBe(1220)
  })

  test('the offset arrives after the call returns: press and scroll wait for it', async () => {
    const list = scroller(VIEW, 2000, [{ at: 1500, make: field('Deep') }], { lateMs: 60 })
    const screen = roots(list.fiber)
    const result = await screen.scroll('Deep')
    expect(result).toMatchObject({ offset: 1220, onScreen: true })
    list.state.offset = 0
    const late = scroller(VIEW, 2000, [{ at: 1500, make: () => pressable({ onPress: () => {} }, rnText('Go')) }], {
      lateMs: 60,
    })
    await expect(roots(late.fiber).press('Go', { scroll: true })).resolves.toMatchObject({ text: 'Go' })
  })
})

describe('nested scrollables', () => {
  test('a scrollEnabled={false} list leaves the scrolling to the one around it', async () => {
    const outerState = { offset: 0 }
    void outerState
    let outer: ReturnType<typeof scroller>
    const innerView = () => ({ x: 0, y: 100 + 1000 - outer.state.offset, width: 400, height: 400 })
    const inner = scroller(innerView, 400, [{ at: 300, make: () => pressable({ onPress: () => {} }, rnText('Nested')) }], {
      props: { scrollEnabled: false },
    })
    outer = scroller(VIEW, 2000, [{ at: 1000, size: 400, make: () => inner.fiber }])
    const screen = roots(outer.fiber)
    await expect(screen.press('Nested')).rejects.toThrow(/scroll:true/)
    await screen.press('Nested', { scroll: true })
    expect(inner.state.calls).toEqual([])
    expect(outer.state.offset).toBeGreaterThan(0)
  })

  test('a horizontal carousel below the fold needs the vertical parent, then itself', async () => {
    let outer: ReturnType<typeof scroller>
    const carouselView = () => ({ x: 0, y: 100 + 1000 - outer.state.offset, width: 400, height: 100 })
    const carousel = scroller(
      carouselView,
      1200,
      [
        { at: 50, make: () => rnText('Near') },
        { at: 900, make: () => rnText('Far') },
      ],
      { horizontal: true },
    )
    outer = scroller(VIEW, 2000, [{ at: 1000, size: 100, make: () => carousel.fiber }])
    const screen = roots(outer.fiber)
    expect(await screen.scroll('Near')).toMatchObject({ onScreen: true })
    expect(carousel.state.calls).toEqual([])
    expect(outer.state.offset).toBeGreaterThan(0)
    outer.state.offset = 0
    expect(await screen.scroll('Far')).toMatchObject({ onScreen: true })
    expect(carousel.state.calls.length).toBe(1)
    expect(outer.state.offset).toBeGreaterThan(0)
  })
})

describe('inverted lists', () => {
  test('scroll against the visual direction', async () => {
    const list = scroller(VIEW, 2000, [{ at: 1500, make: field('Old message') }], {
      inverted: true,
      props: { inverted: true },
    })
    const screen = roots(list.fiber)
    expect(await screen.scroll('Old message')).toMatchObject({ offset: 1220, onScreen: true })
    expect((await screen.scroll({ toStart: true })).offset).toBe(0)
  })

  test('a scaleY(-1) style counts as inverted', async () => {
    const list = scroller(VIEW, 2000, [{ at: 1500, make: field('Old') }], {
      inverted: true,
      props: { style: [{ transform: [{ scaleY: -1 }] }] },
    })
    expect(await roots(list.fiber).scroll('Old')).toMatchObject({ offset: 1220, onScreen: true })
  })
})

describe('scroll arguments', () => {
  test('index picks the target among matches, not the within scrollable', async () => {
    const list = scroller(VIEW, 2000, [
      { at: 1500, make: field('Row') },
      { at: 1700, make: field('Row') },
    ], { props: { testID: 'list' } })
    const screen = roots(list.fiber)
    expect(await screen.scroll('Row', { within: 'list', index: 1 })).toMatchObject({ onScreen: true })
    expect(list.state.offset).toBe(1400)
  })

  test('a row that is not rendered says to scroll by or to the end first', async () => {
    const list = scroller(VIEW, 2000, [{ at: 10, make: field('Row 1') }])
    await expect(roots(list.fiber).press('Row 90', { scroll: true })).rejects.toThrow(/toEnd/)
  })
})

describe('visible area', () => {
  const rowsUnderHeader = () => {
    // A list whose frame runs under a native header: rows scrolled up beneath it
    // are inside the frame but not visible. The screen's own frame starts below it.
    const screenRect = { x: 0, y: 150, width: 400, height: 650 }
    const view = () => ({ x: 0, y: 0, width: 400, height: 800 })
    const list = scroller(view, 2000, [
      { at: 340, make: field('Msg 15') },
      { at: 700, make: field('Msg 3') },
    ])
    list.state.offset = 300
    const screenHost = host({}, screenRect)
    screenHost.type = 'RNSScreen'
    tree(screenHost, list.fiber)
    return { list, screenHost }
  }

  test('a row under the native header is not on screen, and scroll brings it out', async () => {
    const { list, screenHost } = rowsUnderHeader()
    const root = tree(host(), screenHost)
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    expect(screen.snapshot({ all: true }).elements.find((e) => e.text === 'Msg 15')?.onScreen).toBe(false)
    expect(screen.snapshot().elements.map((e) => e.text)).toEqual(['Msg 3'])
    const result = await screen.scroll('Msg 15')
    expect(list.state.calls.length).toBe(1)
    expect(result).toMatchObject({ onScreen: true })
  })

  test('a row behind a bottom tab bar is not on screen', () => {
    const list = scroller(() => ({ x: 0, y: 0, width: 400, height: 800 }), 2000, [
      { at: 730, make: field('Behind') },
      { at: 300, make: field('Clear') },
    ])
    const bar = tree(host({ accessibilityRole: 'tablist' }, { x: 0, y: 700, width: 400, height: 100 }), rnText('Tab'))
    const screen = roots(list.fiber, bar)
    expect(screen.snapshot().elements.map((e) => e.text)).toEqual(['Clear', 'Tab'])
  })

  test('layout that is still moving right after a push is waited out', async () => {
    let top = 0
    const view = () => ({ x: 0, y: 0, width: 400, height: 800 })
    const list = scroller(view, 2000, [{ at: 340, make: field('Msg') }])
    list.state.offset = 300
    const screenHost = host({}, { x: 0, y: 0, width: 400, height: 800 })
    setTimeout(() => (top = 150), 30)
    // The header lands late: the screen frame follows it.
    screenHost.stateNode = { getBoundingClientRect: () => ({ x: 0, y: top, width: 400, height: 800 - top }), checkVisibility: () => true }
    screenHost.type = 'RNSScreen'
    const root = tree(host(), tree(screenHost, list.fiber))
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    const result = await screen.scroll('Msg')
    // Settled at 150: the row scrolled up to y 40 sits under the header, so it scrolled.
    expect(list.state.calls.length).toBe(1)
    expect(result).toMatchObject({ onScreen: true })
  })
})

describe('within a ScrollView testID', () => {
  test('the testID on a plain ScrollView (composite or host) names that scroller, not the one around it', async () => {
    let outer: ReturnType<typeof scroller>
    const carouselView = () => ({ x: 0, y: 100 + 300 - outer.state.offset, width: 400, height: 100 })
    const carousel = scroller(carouselView, 1200, [{ at: 900, make: () => rnText('Far') }], {
      horizontal: true,
      props: { testID: 'carousel' },
    })
    outer = scroller(VIEW, 2000, [{ at: 300, size: 100, make: () => carousel.fiber }], {
      props: { testID: 'outer' },
    })
    const screen = roots(outer.fiber)
    expect(await screen.scroll({ by: 300 }, { within: 'carousel' })).toMatchObject({ offset: 300, max: 800 })
    expect(carousel.state.offset).toBe(300)
    expect(outer.state.offset).toBe(0)
    expect(await screen.scroll({ by: 500 }, { within: 'outer' })).toMatchObject({ offset: 500 })
    expect(outer.state.offset).toBe(500)
  })

  test('the testID on the host of a ScrollView with no other scroller', async () => {
    const list = scroller(VIEW, 2000, [{ at: 10, make: field('Row') }])
    const scrollHost = list.fiber.child as Fiber
    scrollHost.memoizedProps = { testID: 'form-scroll' }
    expect(await roots(list.fiber).scroll({ toEnd: true }, { within: 'form-scroll' })).toMatchObject({ offset: 1400 })
  })

  test('toEnd within a scrollEnabled={false} list falls back to the one around it', async () => {
    let outer: ReturnType<typeof scroller>
    const innerView = () => ({ x: 0, y: 100 + 300 - outer.state.offset, width: 400, height: 400 })
    const inner = scroller(innerView, 400, [], { props: { testID: 'inner-list', scrollEnabled: false } })
    outer = scroller(VIEW, 2000, [{ at: 300, size: 400, make: () => inner.fiber }])
    const screen = roots(outer.fiber)
    expect(await screen.scroll({ toEnd: true }, { within: 'inner-list' })).toMatchObject({ offset: 1400 })
    expect(inner.state.calls).toEqual([])
    const alone = scroller(VIEW, 2000, [], { props: { testID: 'solo', scrollEnabled: false } })
    await expect(roots(alone.fiber).scroll({ toEnd: true }, { within: 'solo' })).rejects.toThrow(/can't be scrolled/)
  })
})
