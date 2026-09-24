import { describe, expect, test } from 'bun:test'

import { collectElements } from '../elements'
import { resolveTarget } from '../targets'
import { WINDOW, host, pressable, rnText, text, textInput, tree } from './fake-tree'

const root = tree(
  host(),
  rnText('Save plant'),
  pressable({ onPress: () => {}, testID: 'save-plant' }, rnText('Save plant')),
  textInput({ onChangeText: () => {}, value: '', placeholder: 'e.g. Fiddle leaf fig', testID: 'plant-name', accessibilityLabel: 'Name' }),
  rnText('Water every 7 days'),
  rnText('Water every 3 days'),
  tree(host({}, { x: 0, y: 2000, width: 10, height: 10 }), text('Far below')),
)
const found = collectElements([root], WINDOW)
const pick = (target: Parameters<typeof resolveTarget>[1], prefer?: 'press' | 'input') =>
  resolveTarget(found, target, prefer && ((f) => !!f[prefer])).element

describe('resolveTarget', () => {
  test('a string tries testID, label, placeholder, then text', () => {
    expect(pick('plant-name').kind).toBe('input')
    expect(pick('Name').testID).toBe('plant-name')
    expect(pick('e.g. Fiddle leaf fig').testID).toBe('plant-name')
    expect(pick('7 days').text).toBe('Water every 7 days')
  })

  test('several matches throw with candidates; index or the wanted kind picks one', () => {
    expect(() => pick('Save plant')).toThrow(/matches 2 elements.*0: text "Save plant"; 1: button #save-plant/)
    expect(pick('Save plant', 'press').testID).toBe('save-plant')
    expect(() => pick('Water every')).toThrow(/matches 2 elements/)
    expect(pick({ text: 'Water every', index: 1 }).text).toBe('Water every 3 days')
    expect(() => pick({ text: 'Water every', index: 5 })).toThrow(/out of range/)
  })

  test('objects match every field they set', () => {
    expect(pick({ testID: 'plant-name', placeholder: 'e.g. Fiddle leaf fig' }).kind).toBe('input')
    expect(() => pick({ testID: 'plant-name', label: 'Other' })).toThrow(/Nothing on screen matches/)
  })

  test('no match lists what is on screen; an off-screen match says so', () => {
    expect(() => pick('Nope')).toThrow(/Nothing on screen matches "Nope". On screen: text "Save plant"; button #save-plant/)
    expect(() => pick('Far below')).toThrow(/which is not on screen/)
  })
})
