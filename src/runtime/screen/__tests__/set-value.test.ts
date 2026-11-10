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
  const size: Record<string, unknown> = {
    testID: 'size',
    value: 'm',
    onValueChange: (v: string, i: number) => {
      calls.push(['size', v, i])
      size.value = v
    },
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
    tree(
      composite(size),
      tree(
        host({}),
        composite({ label: 'Small', value: 's' }),
        composite({ label: 'Medium', value: 'm' }),
        composite({ label: 'Large', value: 'l' }),
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

  test('errors when there is no onLongPress, and with an accessibility action', async () => {
    const { screen, calls } = build({})
    await expect(screen.press('Plain', { long: true })).rejects.toThrow(/no onLongPress/)
    await expect(screen.press('Item', { long: true, action: 'activate' })).rejects.toThrow(/long.*action/)
    expect(calls).toEqual([])
  })
})

describe('gesture handler', () => {
  test('press names the reason when the control is a GestureDetector', async () => {
    const gesture = { handlerName: 'TapGestureHandler', handlers: { onEnd: () => {} } }
    const root = tree(host(), tree(composite({ gesture, testID: 'tap' }), host({ testID: 'tap' }, { x: 10, y: 10, width: 50, height: 50 })))
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    await expect(screen.press('tap')).rejects.toThrow(/react-native-gesture-handler.*UI thread/)
  })
})

// A FlatList: only rows near the window are rendered, so rows move in and out as it scrolls.
describe('scroll:true on a list that has not rendered the row', () => {
  function list(rows = 100) {
    const state = { offset: 0, scrolls: [] as number[] }
    const view = { getBoundingClientRect: (): Rect => ({ x: 0, y: 100, width: 400, height: 600 }), checkVisibility: () => true }
    const content = {
      getBoundingClientRect: (): Rect => ({ x: 0, y: 100 - state.offset, width: 400, height: rows * 40 }),
      checkVisibility: () => true,
    }
    const scrollView = {
      scrollTo: (o: { y: number }) => {
        state.scrolls.push(o.y)
        state.offset = Math.max(0, Math.min(rows * 40 - 600, o.y))
      },
    }
    const cache = new Map<number, Fiber>()
    const build = (): Fiber => {
      const items: Fiber[] = []
      for (let i = 0; i < rows; i++) {
        const top = i * 40
        if (top + 40 < state.offset - 80 || top > state.offset + 680) continue
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

  test('finds a row above the current position too', async () => {
    const { screen, state } = list()
    state.offset = 3000
    expect(await screen.press('Row 3', { scroll: true })).toMatchObject({ testID: 'row-3' })
  })

  test('fails with how far it got when the row does not exist', async () => {
    const { screen } = list(30)
    await expect(screen.press('Row 99', { scroll: true })).rejects.toThrow(/Nothing on screen matches.*paged.*#list.*offset 600 of 600/)
  })

  test('waitFor with scroll pages too', async () => {
    const { screen } = list()
    expect(await screen.waitFor('Row 70', { scroll: true })).toMatchObject({ element: { testID: 'row-70' } })
  })
})
