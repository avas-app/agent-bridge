import { afterEach, describe, expect, test } from 'bun:test'

import { createScreen } from '..'
import { composite, host, pressable, rnText, text, tree, WINDOW } from './fake-tree'

const RECT = { x: 20, y: 200, width: 60, height: 16 }
const screenOf = (...roots: ReturnType<typeof host>[]) =>
  createScreen({ roots: () => roots, window: () => WINDOW })

// <Text>Finding the best route<Text>...</Text></Text> as React Native renders it.
const nested = (rect = RECT) => {
  const inner = host({}, rect)
  inner.type = 'RCTVirtualText'
  const outer = host({}, rect)
  outer.type = 'RCTText'
  return tree(composite(), tree(outer, text('Finding the best route'), tree(inner, text('...'))))
}

describe('screen.findText', () => {
  afterEach(() => {
    delete (globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager
  })

  test('finds visible text and reports it on screen', () => {
    const s = screenOf(rnText('Agent Ride', {}))
    expect(s.findText('Agent Ride')).toMatchObject({ found: 1, onScreen: 1 })
  })

  test('ignores text under an inactive react-native-screens screen', () => {
    const inactive = tree(host({ activityState: 0 }), rnText('Agent Ride'))
    const active = tree(host({ activityState: 2 }), rnText('Account'))
    const s = screenOf(tree(host({}), inactive, active))
    expect(s.findText('Agent Ride').found).toBe(0)
    expect(s.findText('Account')).toMatchObject({ found: 1, onScreen: 1 })
  })

  test('treats undisplayed and off-window hosts as not on screen', () => {
    const hidden = tree(host({}, RECT), text('Hidden'))
    hidden.stateNode = { getBoundingClientRect: () => RECT, checkVisibility: () => false }
    const below = tree(host({}, { x: 0, y: 900, width: 50, height: 10 }), text('Below'))
    const s = screenOf(hidden, below)
    expect(s.findText('Hidden')).toMatchObject({ found: 1, onScreen: 0 })
    expect(s.findText('Below')).toMatchObject({ found: 1, onScreen: 0 })
  })

  test('measures native hosts through Fabric, which reports hidden ones as empty', () => {
    const shown = { shadow: 'shown' }
    const g = globalThis as { nativeFabricUIManager?: unknown }
    g.nativeFabricUIManager = {
      measureInWindow: (node: unknown, done: (...xywh: number[]) => void) =>
        node === shown ? done(20, 200, 60, 16) : done(0, 0, 0, 0),
    }
    const fabric = (node: unknown, content: string) =>
      tree({ ...host({}), stateNode: { node, canonical: {} } }, text(content))
    const s = screenOf(tree(host({}, null), fabric(shown, 'Seeded'), fabric({}, 'Hidden')))
    expect(s.findText('Seeded').matches).toEqual([
      { text: 'Seeded', field: 'text', rect: RECT, onScreen: true },
    ])
    expect(s.findText('Hidden')).toMatchObject({ found: 1, onScreen: 0 })
  })

  test("finds react-dom's lone string children once, and React Native's Text once", () => {
    expect(screenOf(host({ children: 'Seeded' })).findText('Seeded')).toMatchObject({ found: 1, onScreen: 1 })
    const native = tree(host({ children: 'Seeded' }), text('Seeded'))
    expect(screenOf(native).findText('Seeded').found).toBe(1)
  })

  test('matches substrings by default and whole strings with exact', () => {
    const s = screenOf(rnText('Agent Ride'))
    expect(s.findText('Ride').found).toBe(1)
    expect(s.findText('Ride', { exact: true }).found).toBe(0)
  })

  test('matches nested Text as the one string the snapshot shows', () => {
    const s = screenOf(nested())
    expect(s.snapshot().elements.map((e) => e.text)).toEqual(['Finding the best route...'])
    expect(s.findText('Finding the best route...', { exact: true })).toMatchObject({ found: 1, onScreen: 1 })
    expect(s.findText('route...').found).toBe(1)
  })

  test('agrees with the snapshot for animated text', () => {
    // Animated.Text: opacity lives in style; the host still has a rect.
    const fading = rnText('Finding the best route', { style: { opacity: 0.2 } })
    const s = screenOf(fading)
    const shown = s.snapshot().elements.some((e) => e.text === 'Finding the best route')
    expect(shown).toBe(true)
    expect(s.findText('Finding the best route')).toMatchObject({ found: 1, onScreen: 1 })
  })

  test('reports text the snapshot hides as off screen, with near misses', () => {
    const gone = rnText('Finding the best route', {})
    const g = gone.child as ReturnType<typeof host>
    g.stateNode = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }), checkVisibility: () => true }
    const s = screenOf(gone, rnText('Finding the best Route'))
    expect(s.snapshot().elements.map((e) => e.text)).toEqual(['Finding the best Route'])
    expect(s.findText('Finding the best route')).toMatchObject({ found: 1, onScreen: 0 })
    const miss = s.findText('finding the BEST route now')
    expect(miss.found).toBe(0)
    expect(miss.nearMisses).toEqual([
      'text "Finding the best Route"',
      'text "Finding the best route" (off screen)',
    ])
  })

  test('matches accessibility labels, unless labels:false', () => {
    const view = host({ accessibilityLabel: 'Payment method' })
    const s = screenOf(view)
    expect(s.findText('Payment method').matches).toEqual([
      { text: 'Payment method', field: 'label', rect: { x: 20, y: 200, width: 120, height: 40 }, onScreen: true },
    ])
    expect(s.findText('Payment', { labels: false }).found).toBe(0)
    expect(screenOf(host({ 'aria-label': 'Payment method' })).findText('Payment').found).toBe(1)
  })

  test('prefers the rendered text when text and label both match', () => {
    const s = screenOf(pressable({ onPress() {}, accessibilityLabel: 'Save' }, rnText('Save')))
    expect(s.findText('Save')).toMatchObject({ found: 1, matches: [{ field: 'text' }] })
  })
})
