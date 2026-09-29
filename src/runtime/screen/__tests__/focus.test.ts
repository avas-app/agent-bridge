import { describe, expect, test } from 'bun:test'

import { createScreen } from '..'
import type { Fiber } from '../../find-text-core'
import { WINDOW, composite, host, pressable, rnText, tree } from './fake-tree'

const typed = (fiber: Fiber, type: string): Fiber => {
  fiber.type = type
  return fiber
}

const screenOf = (...children: Fiber[]) => {
  const root = tree(host(), ...children)
  return createScreen({ roots: () => [root], window: () => WINDOW })
}

const texts = (screen: ReturnType<typeof screenOf>) =>
  screen.snapshot().elements.map((e) => e.text)

describe('focused screen', () => {
  test('a native stack shows only its last screen, and counts what it skipped', () => {
    const stack = tree(
      typed(host(), 'RNSScreenStack'),
      tree(typed(host({ activityState: 2 }), 'RNSScreen'), rnText('Plants'), rnText('Ferns')),
      tree(typed(host({ activityState: 2 }), 'RNSScreen'), rnText('Plant detail')),
    )
    const screen = screenOf(stack)
    expect(screen.snapshot()).toMatchObject({ hidden: 2 })
    expect(texts(screen)).toEqual(['Plant detail'])
  })

  test('all lists the hidden elements, marked', () => {
    const stack = tree(
      typed(host(), 'RNSScreenStack'),
      tree(typed(host(), 'RNSScreen'), rnText('Plants')),
      tree(typed(host(), 'RNSScreen'), rnText('Detail')),
    )
    const { elements } = screenOf(stack).snapshot({ all: true })
    expect(elements.map((e) => [e.text, e.hidden])).toEqual([
      ['Plants', true],
      ['Detail', undefined],
    ])
  })

  test('inactive tabs: activityState 0, display none (also in a style array) and accessibility hiding', () => {
    const screen = screenOf(
      tree(host({ activityState: 0 }), rnText('Tab A')),
      tree(host({ style: [{ flex: 1 }, [{ display: 'none' }]] }), rnText('Tab B')),
      tree(host({ 'aria-hidden': true }), rnText('Tab C')),
      tree(host({ importantForAccessibility: 'no-hide-descendants' }), rnText('Tab D')),
      tree(host({ style: { display: 'flex' } }), rnText('Tab E')),
    )
    expect(texts(screen)).toEqual(['Tab E'])
    expect(screen.snapshot().hidden).toBe(4)
  })

  test('the top-most modal hides the content under it, and nested modals stack', () => {
    const inner = tree(typed(host(), 'RCTModalHostView'), rnText('Inner'))
    const outer = tree(typed(host(), 'RCTModalHostView'), rnText('Outer'), inner)
    expect(texts(screenOf(rnText('Home'), outer))).toEqual(['Inner'])
    expect(texts(screenOf(rnText('Home'), tree(typed(host(), 'RCTModalHostView'), rnText('Sheet'))))).toEqual([
      'Sheet',
    ])
  })

  test('a full-window overlay (toast) stays reachable under a modal', () => {
    const modal = tree(typed(host(), 'RCTModalHostView'), rnText('Sheet'))
    const toast = tree(typed(host(), 'RNSFullWindowOverlay'), rnText('Saved'))
    expect(texts(screenOf(rnText('Home'), modal, toast))).toEqual(['Sheet', 'Saved'])
  })

  test('a modal inside an unfocused screen does not hide the focused one', () => {
    const modal = tree(typed(host(), 'RCTModalHostView'), rnText('Ghost'))
    const screen = screenOf(tree(host({ activityState: 0 }), modal), rnText('Home'))
    expect(texts(screen)).toEqual(['Home'])
  })

  test('press, fill-less matching and findText ignore hidden duplicates instead of failing', async () => {
    const presses: string[] = []
    const stack = tree(
      typed(host(), 'RNSScreenStack'),
      tree(
        typed(host(), 'RNSScreen'),
        pressable({ onPress: () => presses.push('under') }, rnText('Save')),
      ),
      tree(
        typed(host(), 'RNSScreen'),
        pressable({ onPress: () => presses.push('top') }, rnText('Save')),
      ),
    )
    const screen = screenOf(stack)
    await screen.press('Save')
    expect(presses).toEqual(['top'])
    expect(screen.findText('Save')).toMatchObject({ found: 1, hidden: 1 })
    await expect(screen.waitFor('Save', { timeoutMs: 100 })).resolves.toMatchObject({
      element: { text: 'Save' },
    })
  })

  test('a target only on a hidden screen says so', async () => {
    const stack = tree(
      typed(host(), 'RNSScreenStack'),
      tree(typed(host(), 'RNSScreen'), pressable({ onPress: () => {} }, rnText('Old'))),
      tree(typed(host(), 'RNSScreen'), rnText('New')),
    )
    await expect(screenOf(stack).press('Old')).rejects.toThrow(/not in front/)
  })

  test('visible elements are untouched without any navigator', () => {
    const screen = screenOf(rnText('A'), pressable({ onPress: () => {} }, rnText('B')))
    expect(screen.snapshot()).toEqual({
      elements: [
        expect.objectContaining({ text: 'A' }),
        expect.objectContaining({ text: 'B' }),
      ],
    })
  })
})

describe('native modal screens', () => {
  const pressed: string[] = []
  const tabs = (modal: Record<string, unknown>) => {
    const tabBar = tree(
      host({ accessibilityRole: 'tablist' }),
      pressable({ onPress: () => pressed.push('settings') }, rnText('Settings')),
      rnText('Plants'),
    )
    const stack = tree(
      typed(host(), 'RNSScreenStack'),
      tree(typed(host({ activityState: 2 }), 'RNSScreen'), rnText('Plant list')),
      tree(typed(host({ activityState: 2, ...modal }), 'RNSScreen'), rnText('Sheet content')),
    )
    return screenOf(tree(host(), stack), tabBar)
  }

  test('a presented modal hides the tab bar around its navigator, and press cannot reach it', async () => {
    const screen = tabs({ stackPresentation: 'modal' })
    expect(texts(screen)).toEqual(['Sheet content'])
    expect(screen.findText('Sheet content')).toMatchObject({ found: 1 })
    expect(screen.findText('Settings')).toMatchObject({ found: 0, hidden: 1 })
    await expect(screen.press('Settings')).rejects.toThrow(/not in front/)
    expect(pressed).toEqual([])
  })

  test.each(['formSheet', 'pageSheet', 'fullScreenModal', 'containedModal'])('%s covers everything', (p) => {
    expect(texts(tabs({ stackPresentation: p }))).toEqual(['Sheet content'])
  })

  test('push and undimmed sheets leave the rest reachable', () => {
    expect(texts(tabs({ stackPresentation: 'push' }))).toEqual(['Sheet content', 'Settings', 'Plants'])
    expect(
      texts(tabs({ stackPresentation: 'formSheet', sheetLargestUndimmedDetentIndex: 0 })),
    ).toEqual(['Plant list', 'Sheet content', 'Settings', 'Plants'])
    expect(
      texts(tabs({ stackPresentation: 'formSheet', sheetLargestUndimmedDetentIndex: 'none' })),
    ).toEqual(['Sheet content'])
  })

  test.each(['transparentModal', 'containedTransparentModal'])(
    '%s blocks touches outside it too, tab bar included',
    async (p) => {
      const screen = tabs({ stackPresentation: p })
      expect(texts(screen)).toEqual(['Sheet content'])
      await expect(screen.press('Settings')).rejects.toThrow(/not in front/)
    },
  )

  test('RN Modal content is not clipped by the scroller or tab bar it is declared under', () => {
    const modal = tree(typed(host({}, { x: 20, y: 60, width: 300, height: 40 }), 'RCTModalHostView'), rnText('Marker', {}))
    // A scroller frame and a tab bar that would clip the marker away.
    const view = { x: 0, y: 300, width: 400, height: 200 }
    const scrollView = tree(
      { ...composite(), tag: 1, stateNode: { scrollTo: () => {} } },
      tree(host({}, view), modal),
    )
    const bar = tree(host({ accessibilityRole: 'tablist' }, { x: 0, y: 0, width: 400, height: 100 }), rnText('Tab'))
    const screen = screenOf(scrollView, bar)
    expect(texts(screen)).toEqual(['Marker'])
  })

  test('the first screen of a stack is not a presentation, and an RNSModalScreen is a modal', () => {
    const root = tree(
      typed(host(), 'RNSScreenStack'),
      tree(typed(host({ stackPresentation: 'modal' }), 'RNSScreen'), rnText('Root')),
    )
    expect(texts(screenOf(root, rnText('Tab bar')))).toEqual(['Root', 'Tab bar'])
    const stack = tree(
      typed(host(), 'RNSScreenStack'),
      tree(typed(host(), 'RNSScreen'), rnText('A')),
      tree(typed(host(), 'RNSModalScreen'), rnText('B')),
    )
    expect(texts(screenOf(stack, rnText('Tab bar')))).toEqual(['B'])
  })
})
