import { describe, expect, test } from 'bun:test'

import { createScreen } from '..'
import type { Rect } from '../../find-text-core'
import { WINDOW, host, pressable, rnText, textInput, tree } from './fake-tree'

const at = (y: number): Rect => ({ x: 20, y, width: 200, height: 40 })

function screenOf() {
  const root = tree(
    host(),
    pressable({ testID: 'save', onPress: () => {}, accessibilityLabel: 'Save plant' }),
    pressable({ testID: 'off', onPress: () => {}, disabled: true }, rnText('Delete')),
    textInput({ testID: 'name', placeholder: 'Name', value: 'Fern', onChangeText: () => {} }),
    rnText('Water'),
    rnText('Water'),
  )
  return createScreen({ roots: () => [root], window: () => WINDOW })
}

describe('screen.snapshot text', () => {
  test('one line per element, no rects', () => {
    const text = screenOf().snapshotText()
    expect(text).not.toContain('rect')
    expect(text.split('\n').length).toBeGreaterThan(2)
    expect(text).toContain('button #save label="Save plant"')
    expect(text).toContain('#name placeholder="Name" value="Fern"')
    expect(text).toContain('disabled')
  })

  test('repeated lines carry the index that picks them; named unique lines carry nothing', () => {
    const lines = screenOf().snapshotText().split('\n')
    const water = lines.filter((l) => l.includes('"Water"'))
    expect(water.map((l) => l.match(/index=(\d+)/)?.[1])).toEqual(['0', '1'])
    expect(lines.find((l) => l.includes('#save'))).not.toMatch(/@|index/)
  })

  test('an element with nothing to name it gets its point, even when unique', () => {
    const root = tree(host(), pressable({ onPress: () => {} }), textInput({ onChangeText: () => {} }))
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    for (const l of screen.snapshotText().split('\n')) expect(l).toMatch(/ @\d+,\d+$/)
  })

  test('a long label is not cut, so it can be used as a target', () => {
    const label = 'L'.repeat(90)
    const root = tree(host(), pressable({ onPress: () => {}, accessibilityLabel: label }))
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    expect(screen.snapshotText()).toContain(`label="${label}"`)
  })

  test('an empty filtered result says what the filter matched, not an empty screen', () => {
    expect(screenOf().snapshotText({ kinds: ['webview'] })).toBe('(no webview elements)')
    expect(screenOf().snapshotText()).not.toContain('nothing on screen')
  })

  test('kinds keeps only those kinds', () => {
    const els = screenOf().snapshot({ kinds: ['input'] }).elements
    expect(els.map((e) => e.testID)).toEqual(['name'])
    expect(() => screenOf().snapshot({ kinds: ['nope' as never] })).toThrow('kinds are')
  })

  test('kinds takes a bare string and refuses other shapes clearly', () => {
    expect(screenOf().snapshot({ kinds: 'input' as never }).elements.map((e) => e.testID)).toEqual(['name'])
    expect(() => screenOf().snapshot({ kinds: 5 as never })).toThrow('kinds is a list')
    expect(() => screenOf().snapshot({ kinds: ['switch' as never] })).toThrow('ask for "button"')
  })

  test('within scopes to the elements inside a target', () => {
    const inner = rnText('Inside')
    const outerHost = host({ testID: 'card' }, at(100))
    inner.child!.stateNode = host({}, { x: 30, y: 110, width: 50, height: 20 }).stateNode
    const outside = rnText('Outside')
    outside.child!.stateNode = host({}, at(500)).stateNode
    const root = tree(host(), tree(outerHost, inner), outside)
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    expect(screen.snapshot({ within: 'card' }).elements.map((e) => e.text)).toEqual(['Inside'])
    expect(() => screen.snapshot({ within: 'nope' })).toThrow('Nothing on screen matches')
  })

  test('a bad format is an error', () => {
    expect(() => screenOf().snapshot({ format: 'yaml' as never })).toThrow('format')
  })
})

describe('screen.snapshot within', () => {
  const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })
  const boxed = (props: Record<string, unknown>, r: Rect, ...kids: ReturnType<typeof host>[]) =>
    tree(host(props, r), ...kids)
  const label = (content: string, r: Rect) => {
    const t = rnText(content)
    t.child!.stateNode = host({}, r).stateNode
    return t
  }

  test('keeps the scope\'s children, not its ancestors or what only overlaps it', () => {
    const card = boxed({ testID: 'card' }, rect(20, 350, 200, 100), label('In card', rect(30, 360, 50, 20)))
    const overlay = boxed({ testID: 'overlay' }, rect(0, 300, 400, 200))
    const root = tree(host(), boxed({ testID: 'screen' }, rect(0, 0, 400, 800), card, overlay))
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    const got = screen.snapshot({ within: 'card' }).elements
    expect(got.map((e) => e.text ?? e.testID)).toEqual(['In card'])
  })

  test('keeps a child bigger than the scope and, with all, off-screen rows', () => {
    const wide = label('Wide row', rect(0, 100, 900, 40))
    const far = label('Far row', rect(20, 2000, 100, 40))
    const list = boxed({ testID: 'list' }, rect(0, 80, 400, 200), wide, far)
    const root = tree(host(), list)
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    expect(screen.snapshot({ within: 'list' }).elements.map((e) => e.text)).toEqual(['Wide row'])
    expect(screen.snapshot({ within: 'list', all: true }).elements.map((e) => e.text)).toEqual([
      'Wide row',
      'Far row',
    ])
  })

  test('several matches: the error shows the form snapshot accepts, and it works', () => {
    const a = boxed({ testID: 'dup' }, rect(0, 100, 100, 50), label('First', rect(0, 100, 40, 20)))
    const b = boxed({ testID: 'dup' }, rect(0, 300, 100, 50), label('Second', rect(0, 300, 40, 20)))
    const root = tree(host(), a, b)
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    expect(() => screen.snapshot({ within: 'dup' })).toThrow('{"within":{"testID":"dup","index":1}}')
    expect(screen.snapshot({ within: { testID: 'dup', index: 1 } }).elements.map((e) => e.text)).toEqual(['Second'])
  })

  test('an empty scope says so', () => {
    const root = tree(host(), boxed({ testID: 'empty' }, rect(0, 100, 100, 50)))
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    expect(screen.snapshotText({ within: 'empty' })).toMatch(/^\(no elements inside view #empty/)
  })
})
