import { describe, expect, test } from 'bun:test'

import { createScreen } from '..'
import type { Fiber, Rect } from '../../find-text-core'
import { WINDOW, composite, host, pressable, rnText, tree } from './fake-tree'

function setup() {
  const calls: unknown[][] = []
  const volume: Record<string, unknown> = {
    testID: 'volume',
    value: 3,
    minimumValue: 0,
    maximumValue: 10,
    onValueChange: (v: number) => {
      calls.push(['volume', v])
      volume.value = v
    },
    onSlidingComplete: (v: number) => calls.push(['complete', v]),
  }
  const item = (label: string, value: string) => ({ type: 'PickerItem', props: { label, value } })
  const size: Record<string, unknown> = {
    testID: 'size',
    selectedValue: 'm',
    // Picker.Item is never rendered: the native picker reads these elements.
    children: [item('Small', 's'), item('Medium', 'm'), item('Large', 'l')],
    onValueChange: (v: string, i: number) => {
      calls.push(['size', v, i])
      size.selectedValue = v
    },
  }
  // @react-native-community/slider: minimumValue/maximumValue default to 0 and 1 inside the component.
  const unit: Record<string, unknown> = {
    testID: 'unit',
    onSlidingComplete: (v: number) => calls.push(['unit-complete', v]),
    onSlidingStart: (v: number) => calls.push(['unit-start', v]),
  }
  const stepped: Record<string, unknown> = {
    testID: 'stepped',
    value: 20,
    minimumValue: 0,
    maximumValue: 100,
    step: 10,
    onValueChange: (v: number) => calls.push(['stepped', v]),
  }
  // @react-native-segmented-control: the README's onChange with nativeEvent, no onValueChange.
  const mode: Record<string, unknown> = {
    testID: 'mode',
    values: ['Day', 'Night'],
    selectedIndex: 0,
    onChange: (e: { nativeEvent: { selectedSegmentIndex: number } }) =>
      calls.push(['mode', e.nativeEvent.selectedSegmentIndex]),
  }
  const root = tree(
    host(),
    // RN's Switch: a composite with the value and onValueChange over a host.
    tree(
      composite({ testID: 'dark', value: false, onValueChange: (v: boolean) => calls.push(['dark', v]) }),
      { ...host({ value: false }), type: 'RCTSwitch' },
    ),
    // A row with its own onPress around a switch of its own.
    pressable(
      { onPress: () => calls.push(['row']), testID: 'row' },
      rnText('Sound'),
      tree(
        composite({ testID: 'sound', value: true, onValueChange: (v: boolean) => calls.push(['sound', v]) }),
        { ...host({ value: true }), type: 'RCTSwitch' },
      ),
    ),
    tree(composite(volume), host({})),
    tree(composite(size), host({})),
    tree(composite(unit), { ...host({}), type: 'RNCSlider' }),
    tree(composite(stepped), { ...host({}), type: 'RNCSlider' }),
    tree(composite(mode), host({})),
    // A Switch still loading its value, inside a row with an onPress.
    pressable(
      { onPress: () => calls.push(['wifi-row']), testID: 'wifi-row' },
      tree(
        composite({ testID: 'wifi', onValueChange: (v: boolean) => calls.push(['wifi', v]) }),
        { ...host({}), type: 'RCTSwitch' },
      ),
    ),
    tree(composite({ testID: 'locked', value: 1, disabled: true, onValueChange: () => calls.push(['locked']) }), host({})),
  )
  const screen = createScreen({ roots: () => [root], window: () => WINDOW })
  return { screen, calls }
}

describe('setValue', () => {
  test('a switch: calls onValueChange with the boolean', async () => {
    const { screen, calls } = setup()
    const result = await screen.setValue('dark', true)
    expect(calls).toEqual([['dark', true]])
    expect(result).toMatchObject({ element: { testID: 'dark', checked: false }, value: false })
    expect(result.warning).toMatch(/still/)
  })

  test('a slider: onValueChange then onSlidingComplete, read back after the render', async () => {
    const { screen, calls } = setup()
    const result = await screen.setValue('volume', 7)
    expect(calls).toEqual([['volume', 7], ['complete', 7]])
    expect(result).toMatchObject({ value: 7, element: { testID: 'volume', value: '7' } })
    expect(result.warning).toBeUndefined()
  })

  test('checks the type and the range', async () => {
    const { screen, calls } = setup()
    await expect(screen.setValue('volume', 'loud')).rejects.toThrow(/number/)
    await expect(screen.setValue('volume', 11)).rejects.toThrow(/between 0 and 10/)
    await expect(screen.setValue('dark', 1)).rejects.toThrow(/true or false/)
    expect(calls).toEqual([])
  })

  test('a picker: the value must be one of its items, and the index goes along', async () => {
    const { screen, calls } = setup()
    const result = await screen.setValue('size', 'l')
    expect(calls).toEqual([['size', 'l', 2]])
    expect(result.value).toBe('l')
    await expect(screen.setValue('size', 'xl')).rejects.toThrow(/one of "s", "m", "l"/)
  })

  test('refuses disabled controls unless forced, and things with no onValueChange', async () => {
    const { screen, calls } = setup()
    await expect(screen.setValue('locked', 2)).rejects.toThrow(/disabled/)
    await screen.setValue('locked', 2, { force: true })
    expect(calls).toEqual([['locked']])
    await expect(screen.setValue('Sound', true)).rejects.toThrow(/no onValueChange/)
  })
})

describe('setValue on the real components\' shapes', () => {
  test('a picker reads its items from children, and the index goes along', async () => {
    const { screen, calls } = setup()
    await screen.setValue('size', 'l')
    expect(calls).toEqual([['size', 'l', 2]])
    await expect(screen.setValue('size', 5)).rejects.toThrow(/one of "s", "m", "l"/)
  })

  test('a slider with only onSlidingComplete defaults to 0..1, and calls start, change, complete', async () => {
    const { screen, calls } = setup()
    await expect(screen.setValue('unit', 50)).rejects.toThrow(/between 0 and 1/)
    await expect(screen.setValue('unit', 'x')).rejects.toThrow(/number/)
    const result = await screen.setValue('unit', 0.5)
    expect(calls).toEqual([['unit-start', 0.5], ['unit-complete', 0.5]])
    expect(result.warning).toBeUndefined()
  })

  test('a slider step is enforced, and a slider never warns that its value is only a start value', async () => {
    const { screen, calls } = setup()
    await expect(screen.setValue('stepped', 25)).rejects.toThrow(/steps of 10.*nearest: 20, 30/)
    const result = await screen.setValue('stepped', 30)
    expect(calls).toEqual([['stepped', 30]])
    expect(result.warning).toBeUndefined()
  })

  test('a segmented control with only onChange gets the nativeEvent', async () => {
    const { screen, calls } = setup()
    await screen.setValue('mode', 'Night')
    expect(calls).toEqual([['mode', 1]])
    await expect(screen.setValue('mode', 'Dusk')).rejects.toThrow(/one of "Day", "Night"/)
  })

  test('a switch with no value yet is still a switch', async () => {
    const { screen, calls } = setup()
    await expect(screen.setValue('wifi', 'yes')).rejects.toThrow(/true or false/)
    expect(await screen.press('wifi')).toMatchObject({ via: 'onValueChange' })
    expect(calls).toEqual([['wifi', true]])
  })
})

describe('press on a switch', () => {
  test('toggles it with onValueChange(!value) instead of pressing the row', async () => {
    const { screen, calls } = setup()
    const result = await screen.press('dark')
    expect(calls).toEqual([['dark', true]])
    expect(result).toMatchObject({ testID: 'dark', via: 'onValueChange' })
    await screen.press('sound')
    expect(calls[1]).toEqual(['sound', false])
  })
})

describe('long press', () => {
  const build = (props: Record<string, unknown>) => {
    const calls: string[] = []
    const log = (n: string) => () => calls.push(n)
    const root = tree(
      host(),
      pressable({ onPress: log('press'), onLongPress: log('long'), onPressIn: log('in'), onPressOut: log('out'), testID: 'a', ...props }, rnText('Item')),
      pressable({ onPress: log('press-b'), testID: 'b' }, rnText('Plain')),
      tree(composite({ onLongPress: log('menu') }), tree(host({}), rnText('Row'))),
    )
    return { calls, screen: createScreen({ roots: () => [root], window: () => WINDOW }) }
  }

  test('calls onPressIn, onLongPress, onPressOut and not onPress', async () => {
    const { screen, calls } = build({})
    const result = await screen.press('Item', { long: true })
    expect(calls).toEqual(['in', 'long', 'out'])
    expect(result).toMatchObject({ via: 'onLongPress' })
  })

  test('an ancestor with onLongPress handles text inside it', async () => {
    const { screen, calls } = build({})
    expect(await screen.press('Row', { long: true })).toMatchObject({ via: 'ancestor:onLongPress' })
    expect(calls).toEqual(['menu'])
  })

  test('an inner Pressable with no onLongPress shadows an outer onLongPress', async () => {
    const calls: string[] = []
    const root = tree(
      host(),
      tree(
        composite({ onLongPress: () => calls.push('outer') }),
        pressable({ onPress: () => calls.push('inner') }, rnText('Inside')),
      ),
    )
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    await expect(screen.press('Inside', { long: true })).rejects.toThrow(/no onLongPress/)
    expect(calls).toEqual([])
  })

  test('errors when there is no onLongPress, and with an accessibility action', async () => {
    const { screen, calls } = build({})
    await expect(screen.press('Plain', { long: true })).rejects.toThrow(/no onLongPress/)
    await expect(screen.press('Item', { long: true, action: 'activate' })).rejects.toThrow(/long.*action/)
    expect(calls).toEqual([])
  })
})

describe('gesture handler', () => {
  const tap = { handlerName: 'TapGestureHandler', handlers: { onEnd: () => {} }, config: {} }
  const pan = { handlerName: 'PanGestureHandler', handlers: { onUpdate: () => {} }, config: {} }
  const box = { x: 10, y: 10, width: 50, height: 50 }
  const build = (inner: Fiber) => {
    const calls: string[] = []
    const root = tree(host(), inner)
    return { calls, screen: createScreen({ roots: () => [root], window: () => WINDOW }) }
  }

  test('press names the reason when the control is inside a tap GestureDetector', async () => {
    const { screen } = build(tree(composite({ gesture: tap }), tree(composite({ testID: 'tap' }), host({ testID: 'tap' }, box))))
    await expect(screen.press('tap')).rejects.toThrow(/inside a react-native-gesture-handler GestureDetector.*UI thread/)
  })

  test('v3 hook gestures (type) and composed gestures count too', async () => {
    const v3 = build(tree(composite({ gesture: { type: 'LongPressGestureHandler', config: {} } }), host({ testID: 'v3' }, box)))
    await expect(v3.screen.press('v3')).rejects.toThrow(/GestureDetector/)
    const composed = build(tree(composite({ gesture: { gestures: [pan, tap] } }), host({ testID: 'c' }, box)))
    await expect(composed.screen.press('c')).rejects.toThrow(/GestureDetector/)
  })

  test('a pan detector (drawer, swipeable) around the screen is not blamed', async () => {
    const { screen } = build(tree(composite({ gesture: pan }), host({ testID: 'plain' }, box)))
    await expect(screen.press('plain')).rejects.toThrow(/^(?!.*GestureDetector)/)
  })

  test('a tap detector between the element and a Pressable row stops the press falling to the row', async () => {
    const { screen, calls } = build(
      pressable(
        { onPress: () => calls.push('row'), testID: 'row' },
        tree(composite({ gesture: tap }), tree(composite({ testID: 'inner' }), host({ testID: 'inner' }, box))),
      ),
    )
    await expect(screen.press('inner')).rejects.toThrow(/GestureDetector.*ancestor/)
    expect(calls).toEqual([])
  })

  test('a detector above the row it is not between is ignored', async () => {
    const { screen, calls } = build(
      tree(composite({ gesture: tap }), pressable({ onPress: () => calls.push('row'), testID: 'row' }, rnText('Row'))),
    )
    await screen.press('Row')
    expect(calls).toEqual(['row'])
  })
})

// A FlatList: only rows near the window are rendered, so rows move in and out as it scrolls.
// With `lag`, rows follow the offset 60 ms after scrollTo and the content only grows as rows
// render (no getItemLayout), as a real VirtualizedList does after onScroll.
describe('scroll:true on a list that has not rendered the row', () => {
  function list(rows = 100, lag = false, extra: Fiber[] = [], win = { before: 80, after: 680 }, fixedTotal = false) {
    const state = { offset: 0, shown: 0, grown: 0, scrolls: [] as number[] }
    const total = () => (lag && !fixedTotal ? Math.max(state.grown, 640) : rows * 40)
    const view = { getBoundingClientRect: (): Rect => ({ x: 0, y: 100, width: 400, height: 600 }), checkVisibility: () => true }
    const content = {
      getBoundingClientRect: (): Rect => ({ x: 0, y: 100 - state.offset, width: 400, height: total() }),
      checkVisibility: () => true,
    }
    const scrollView = {
      scrollTo: (o: { y: number }) => {
        state.scrolls.push(o.y)
        state.offset = Math.max(0, Math.min(total() - 600, o.y))
        if (lag) setTimeout(() => (state.shown = state.offset), 60)
        else state.shown = state.offset
      },
    }
    const cache = new Map<number, Fiber>()
    const build = (): Fiber => {
      const items: Fiber[] = []
      for (let i = 0; i < rows; i++) {
        const top = i * 40
        if (top + 40 < state.shown - win.before || top > state.shown + win.after) continue
        state.grown = Math.max(state.grown, top + 40)
        let row = cache.get(i)
        if (!row) {
          // Rendered rows keep their fibers, as in React.
          row = pressable({ onPress: () => {}, testID: `row-${i}` }, rnText(`Row ${i}`))
          for (let f: Fiber | null = row; f; f = f.child) {
            if (f.tag === 5) f.stateNode = {
              getBoundingClientRect: (): Rect => ({ x: 0, y: 100 + top - state.offset, width: 400, height: 40 }),
              checkVisibility: () => true,
            }
          }
          cache.set(i, row)
        }
        items.push(row)
      }
      const contentHost = { ...host({}), stateNode: content }
      const viewHost = { ...host({}), stateNode: view }
      const inner = { ...composite({}), tag: 1, stateNode: scrollView }
      return tree(
        host(),
        tree(
          { ...composite({ testID: 'list', renderItem: () => null, data: [] }), tag: 1, stateNode: { scrollToOffset: () => {} } },
          tree(inner, tree(viewHost, tree(contentHost, ...items))),
        ),
        ...extra,
      )
    }
    return { state, screen: createScreen({ roots: () => [build()], window: () => WINDOW }) }
  }

  test('without scroll:true the row is not found', async () => {
    const { screen } = list()
    await expect(screen.press('Row 60')).rejects.toThrow(/Nothing on screen matches/)
  })

  test('press pages down until the row renders, then presses it', async () => {
    const { screen, state } = list()
    const result = await screen.press('Row 60', { scroll: true })
    expect(result).toMatchObject({ testID: 'row-60' })
    expect(state.scrolls.length).toBeGreaterThan(1)
  })

  test('finds a row above the current position first, in few pages', async () => {
    const { screen, state } = list()
    state.offset = state.shown = 3000
    expect(await screen.press('row-3', { scroll: true })).toMatchObject({ testID: 'row-3' })
    expect(state.scrolls.length).toBeLessThanOrEqual(9)
  })

  test('rows that render after the offset lands, in a list whose content grows as it renders', async () => {
    const { screen } = list(100, true)
    expect(await screen.press('Row 30', { scroll: true })).toMatchObject({ testID: 'row-30' })
  })

  test('a row that does not exist leaves the list where it started and says how far it got', async () => {
    const { screen, state } = list(30)
    state.offset = state.shown = 200
    await expect(screen.press('Row 99', { scroll: true })).rejects.toThrow(
      /Nothing on screen matches.*paged.*#list.*down to offset 600 of 600.*scrolled back to offset 200/,
    )
    expect(state.offset).toBe(200)
    expect(state.scrolls.at(-1)).toBe(200)
  })

  test('a long list with a wide render window is crossed in few pages', async () => {
    // VirtualizedList renders ~10 viewports; stepping by the rendered span reaches row 480 in a few jumps.
    const { screen, state } = list(500, true, [], { before: 3000, after: 3600 }, true)
    expect(await screen.press('row-480', { scroll: true })).toMatchObject({ testID: 'row-480' })
    expect(state.scrolls.length).toBeLessThanOrEqual(8)
  })

  test('starting at the bottom, the whole budget goes to paging up', async () => {
    const { screen, state } = list(500, true, [], { before: 3000, after: 3600 }, true)
    state.offset = state.shown = 500 * 40 - 600
    expect(await screen.press('row-20', { scroll: true })).toMatchObject({ testID: 'row-20' })
  })

  test('{scroll:{timeoutMs}} sets the time budget and a missing row fails within it', async () => {
    const { screen, state } = list(500, true, [], { before: 80, after: 680 }, true)
    state.offset = state.shown = 3000
    const t = performance.now()
    await expect(screen.press('Row 9999', { scroll: { timeoutMs: 400 } })).rejects.toThrow(
      /scrolled back to offset 3000.*400 ms budget/,
    )
    expect(performance.now() - t).toBeLessThan(1500)
    expect(state.offset).toBe(3000)
  })

  test('scroll options are checked', async () => {
    const { screen } = list()
    await expect(screen.press('Row 60', { scroll: { timeoutMs: -1 } })).rejects.toThrow(/positive number/)
    await expect(screen.press('Row 60', { scroll: { pages: 3 } as never })).rejects.toThrow(/Unknown scroll option "pages"/)
  })

  test('only one list is paged: a horizontal carousel is left alone', async () => {
    const calls: number[] = []
    const carousel = tree(
      { ...composite({ testID: 'carousel', horizontal: true, renderItem: () => null }), tag: 1, stateNode: { scrollTo: (o: { x: number }) => calls.push(o.x) } },
      host({}, { x: 0, y: 0, width: 400, height: 90 }),
    )
    const { screen } = list(30, false, [carousel])
    await expect(screen.press('Row 99', { scroll: true })).rejects.toThrow(/Not paged: .*carousel/)
    expect(calls).toEqual([])
  })

  test('with {index} it pages until that many matches have rendered', async () => {
    const { screen } = list()
    const result = await screen.press({ text: 'ow 5', index: 3 }, { scroll: true })
    expect(result.testID).toMatch(/^row-5\d$/)
  })

  test('a point target cannot be scrolled to', async () => {
    const { screen, state } = list()
    await expect(screen.press({ at: [10, 10] }, { scroll: true })).rejects.toThrow(/point on the screen/)
    expect(state.scrolls).toEqual([])
  })

  test('with no list on screen it says so', async () => {
    const root = tree(host(), pressable({ onPress: () => {} }, rnText('Only')))
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    await expect(screen.press('Row 9', { scroll: true })).rejects.toThrow(/found no FlatList, SectionList or FlashList/)
  })

  test('waitFor does not page, and says what to do instead', async () => {
    const { screen } = list()
    await expect(screen.waitFor('Row 70', { scroll: true, timeoutMs: 200 })).rejects.toThrow(
      /waitFor does not page lists.*press, fill or setValue/,
    )
  })
})
