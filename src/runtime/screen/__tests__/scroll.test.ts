import { describe, expect, test } from 'bun:test'

import { createScreen } from '..'
import type { Fiber, Rect } from '../../find-text-core'
import { WINDOW, composite, host, pressable, rnText, textInput, tree } from './fake-tree'

// A ScrollView 400x600 at y=100 over 2000 points of content. Items sit at a
// content y; their window y moves with the offset, like the real thing.
function setup(extra: Record<string, unknown> = {}, list: Record<string, unknown> = {}) {
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
  const root = tree(host(), rnText('Header'), scroller)
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
    const { screen } = setup({ 'aria-hidden': true })
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
