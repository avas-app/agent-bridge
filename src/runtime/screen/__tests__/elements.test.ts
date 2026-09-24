import { describe, expect, test } from 'bun:test'

import { collectElements } from '../elements'
import { createScreen } from '..'
import { WINDOW, composite, host, pressable, rnText, text, textInput, tree } from './fake-tree'

const elementsOf = (...children: ReturnType<typeof host>[]) =>
  collectElements([tree(host(), ...children)], WINDOW).map((f) => f.element)

describe('collectElements', () => {
  test('a Pressable is one button with the text beneath it, icon glyphs dropped', () => {
    const button = pressable(
      { onPress: () => {}, testID: 'add-plant', accessibilityLabel: 'Add plant', accessibilityRole: 'button' },
      rnText('\uF101'),
      rnText('Add'),
    )
    expect(elementsOf(button)).toEqual([
      {
        kind: 'button',
        testID: 'add-plant',
        label: 'Add plant',
        role: 'button',
        text: 'Add',
        rect: { x: 20, y: 200, width: 120, height: 40 },
      },
    ])
  })

  test('a TextInput is one input with value, placeholder and editable', () => {
    const input = textInput({ onChangeText: () => {}, value: 'Fern', placeholder: 'Name', testID: 'plant-name' })
    expect(elementsOf(input)).toMatchObject([
      { kind: 'input', testID: 'plant-name', value: 'Fern', placeholder: 'Name', editable: true },
    ])
    const readOnly = textInput({ onChangeText: () => {}, value: '', editable: false })
    expect(elementsOf(readOnly)[0]).toMatchObject({ kind: 'input', editable: false })
  })

  test('a field component handing its props to a TextInput is one input, measured at the TextInput', () => {
    const onChangeText = () => {}
    const props = { testID: 'plant-name', onChangeText, value: '', maxLength: 30 }
    const inner = { x: 20, y: 240, width: 300, height: 44 }
    const field = tree(
      composite(props),
      tree(host(), rnText('Name'), tree(composite(props), host(props, inner))),
    )
    const found = collectElements([tree(host(), field)], WINDOW)
    expect(found.map((f) => [f.element.kind, f.element.testID ?? f.element.text])).toEqual([
      ['input', 'plant-name'],
      ['text', 'Name'],
    ])
    expect(found[0]).toMatchObject({ element: { rect: inner }, maxLength: 30, input: field })
  })

  test('react-dom inputs count through onChange plus value', () => {
    const input = host({ onChange: () => {}, value: 'x' })
    expect(elementsOf(input)).toMatchObject([{ kind: 'input', value: 'x' }])
    expect(elementsOf(host({ onChange: () => {} }))).toEqual([])
  })

  test('text outside controls, joined per host; testID views without text', () => {
    const subtitle = tree(composite(), tree(host(), text('5'), text(' plants · '), text('1'), text(' to water')))
    const card = tree(composite({ testID: 'card' }), host({ testID: 'card' }))
    expect(elementsOf(subtitle, card)).toEqual([
      { kind: 'text', text: '5 plants · 1 to water', rect: expect.any(Object) },
      { kind: 'view', testID: 'card', rect: expect.any(Object) },
    ])
  })

  test('a testID wrapper around a Pressable merges into the button', () => {
    const wrapped = tree(composite({ testID: 'save' }), pressable({ onPress: () => {}, disabled: true }, rnText('Save')))
    expect(elementsOf(wrapped)).toMatchObject([{ kind: 'button', testID: 'save', text: 'Save', disabled: true }])
  })

  test('a button inside a pressable card is its own element', () => {
    const card = pressable({ onPress: () => {} }, rnText('Fern'), pressable({ onPress: () => {} }, rnText('Delete')))
    expect(elementsOf(card).map((e) => [e.kind, e.text])).toEqual([
      ['button', 'Fern'],
      ['button', 'Delete'],
    ])
  })

  test('skips everything under an inactive screen', () => {
    const inactive = tree(host({ activityState: 0 }), rnText('Hidden tab'), pressable({ onPress: () => {} }, rnText('Go')))
    const active = tree(host({ activityState: 2 }), rnText('Plants'))
    expect(elementsOf(inactive, active).map((e) => e.text)).toEqual(['Plants'])
  })

  test('snapshot lists on-screen elements, and off-screen ones with all', () => {
    const below = tree(composite(), tree(host({}, { x: 0, y: 900, width: 50, height: 10 }), text('Below')))
    const root = tree(host(), rnText('Above'), below)
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    expect(screen.snapshot().elements.map((e) => e.text)).toEqual(['Above'])
    expect(screen.snapshot({ all: true }).elements.map((e) => [e.text, e.onScreen])).toEqual([
      ['Above', true],
      ['Below', false],
    ])
  })
})
