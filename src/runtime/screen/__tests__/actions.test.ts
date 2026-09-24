import { describe, expect, test } from 'bun:test'

import { createScreen } from '..'
import { WINDOW, host, pressable, rnText, textInput, tree } from './fake-tree'

function setup() {
  const calls: unknown[][] = []
  const log =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push([name, ...args])
  const input = (props: Record<string, unknown>) =>
    textInput({
      onFocus: log('focus'),
      onChangeText: log('changeText'),
      onChange: (e: { nativeEvent: { text: string } }) => calls.push(['change', e.nativeEvent.text]),
      onSubmitEditing: (e: { nativeEvent: { text: string } }) => calls.push(['submit', e.nativeEvent.text]),
      onBlur: log('blur'),
      value: '',
      ...props,
    })
  const root = tree(
    host(),
    input({ testID: 'days', maxLength: 2 }),
    input({ testID: 'locked', editable: false }),
    pressable({ onPress: log('press'), onPressIn: log('in'), onPressOut: log('out'), testID: 'save' }, rnText('Save')),
    pressable({ onPress: log('press'), disabled: true, testID: 'off' }, rnText('Off')),
  )
  const screen = createScreen({ roots: () => [root], window: () => WINDOW })
  return { screen, calls }
}

describe('fill', () => {
  test('calls focus, changeText, change, submit, blur with the text cut to maxLength', async () => {
    const { screen, calls } = setup()
    const result = await screen.fill('days', '123', { submit: true })
    expect(result).toMatchObject({ filled: '12', element: { kind: 'input', testID: 'days' } })
    expect(calls.map((c) => c[0])).toEqual(['focus', 'changeText', 'change', 'submit', 'blur'])
    expect(calls.slice(1, 4).map((c) => c[1])).toEqual(['12', '12', '12'])
  })

  test('refuses inputs that are not editable, and things that are not inputs', async () => {
    const { screen, calls } = setup()
    expect(screen.fill('locked', 'x')).rejects.toThrow(/not editable/)
    expect(screen.fill('Save', 'x')).rejects.toThrow(/not a text input/)
    expect(calls).toEqual([])
  })
})

describe('press', () => {
  test('calls pressIn, press, pressOut and returns the element', async () => {
    const { screen, calls } = setup()
    expect(await screen.press('Save')).toMatchObject({ kind: 'button', testID: 'save', text: 'Save' })
    expect(calls.map((c) => c[0])).toEqual(['in', 'press', 'out'])
    expect(calls[1]?.[1]).toMatchObject({ nativeEvent: { pageX: 80, pageY: 220 } })
  })

  test('refuses disabled buttons', async () => {
    const { screen, calls } = setup()
    expect(screen.press('off')).rejects.toThrow(/button #off "Off" disabled is disabled/)
    expect(calls).toEqual([])
  })
})
