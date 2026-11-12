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

  test('a position shows only on lines that repeat', () => {
    const lines = screenOf().snapshotText().split('\n')
    const water = lines.filter((l) => l.includes('"Water"'))
    expect(water.length).toBe(2)
    for (const l of water) expect(l).toMatch(/ @\d+,\d+$/)
    expect(lines.find((l) => l.includes('#save'))).not.toContain('@')
  })

  test('kinds keeps only those kinds', () => {
    const els = screenOf().snapshot({ kinds: ['input'] }).elements
    expect(els.map((e) => e.testID)).toEqual(['name'])
    expect(() => screenOf().snapshot({ kinds: ['nope' as never] })).toThrow('kinds are')
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
