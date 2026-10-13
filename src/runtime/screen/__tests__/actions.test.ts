import { describe, expect, test } from 'bun:test'

import { createScreen } from '..'
import { WINDOW, composite, host, pressable, rnText, textInput, tree } from './fake-tree'

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
    pressable({ onPress: log('copy'), testID: 'copy' }, rnText('Save copy')),
    input({ placeholder: 'Name' }),
    input({ placeholder: 'Name' }),
    pressable({ onPress: log('press'), disabled: true, testID: 'off' }, rnText('Off')),
    tree(composite({ onPress: log('icon') }), host({}, { x: 300, y: 100, width: 40, height: 40 })),
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
    await expect(screen.fill('locked', 'x')).rejects.toThrow(/not editable/)
    await expect(screen.fill('Save', 'x')).rejects.toThrow(/not a text input/)
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
    await expect(screen.press('off')).rejects.toThrow(/button #off "Off" disabled is disabled/)
    expect(calls).toEqual([])
  })

  test('refusal mentions force, and force presses anyway', async () => {
    const { screen, calls } = setup()
    await expect(screen.press('off')).rejects.toThrow(/pass \{"force":true\}/)
    await screen.press('off', { force: true })
    expect(calls.map((c) => c[0])).toEqual(['press'])
  })

  test('an icon-only button is pressed by the point it covers', async () => {
    const { screen, calls } = setup()
    await screen.press({ at: [320, 120] })
    expect(calls.map((c) => c[0])).toEqual(['icon'])
  })

  test('unknown keys press nothing', async () => {
    const { screen, calls } = setup()
    await expect(screen.press({ near: 'Save' } as never)).rejects.toThrow(/Unknown target key/)
    expect(calls).toEqual([])
  })

  test('index works inside the target and as a trailing option', async () => {
    const { screen, calls } = setup()
    await expect(screen.press('Sav')).rejects.toThrow(/matches 2 elements.*\["Sav",\{"index":1\}\]/)
    await screen.press('Sav', { index: 1 })
    await screen.press({ testID: 'save', index: 0 })
    await screen.press('Save', { index: 0 })
    expect(calls.map((c) => c[0])).toEqual(['copy', 'in', 'press', 'out', 'in', 'press', 'out'])
  })
})

describe('press through accessibility actions', () => {
  function setupActions() {
    const calls: unknown[][] = []
    const onAction = (name: string) => (e: { nativeEvent: { actionName: string } }) =>
      calls.push([name, e.nativeEvent.actionName])
    // A swipe-to-confirm: an Animated.View with no onPress, operable by screen readers.
    const swipe = (props: Record<string, unknown>, ...children: ReturnType<typeof host>[]) => {
      const all = {
        accessible: true,
        accessibilityRole: 'button',
        accessibilityActions: [{ name: 'activate', label: props.accessibilityLabel }],
        ...props,
      }
      return tree(composite(all), tree(host(all), ...children))
    }
    const root = tree(
      host(),
      swipe({ accessibilityLabel: 'Swipe to confirm', onAccessibilityAction: onAction('confirm') }, rnText('Swipe to confirm')),
      swipe({ accessibilityLabel: 'Swipe to cancel', onAccessibilityAction: onAction('cancel'), accessibilityState: { disabled: true } }),
      swipe({ onAccessibilityAction: onAction('track') }, host({ testID: 'thumb' })),
      pressable({
        onPress: () => calls.push(['press']),
        accessibilityActions: [{ name: 'activate' }],
        onAccessibilityAction: onAction('pressable'),
        testID: 'both',
      }),
      tree(
        composite({
          accessibilityLabel: 'Volume',
          accessibilityActions: [{ name: 'increment' }, { name: 'decrement' }],
          onAccessibilityAction: onAction('volume'),
        }),
        host({}),
      ),
    )
    return { screen: createScreen({ roots: () => [root], window: () => WINDOW }), calls }
  }

  test('a swipe button with only onAccessibilityAction is a button that press activates', async () => {
    const { screen, calls } = setupActions()
    const { elements } = screen.snapshot()
    expect(elements.filter((e) => e.label === 'Swipe to confirm')).toEqual([
      expect.objectContaining({ kind: 'button', text: 'Swipe to confirm', actions: ['activate'] }),
    ])
    expect(await screen.press('Swipe to confirm')).toMatchObject({
      kind: 'button',
      via: 'accessibilityAction:activate',
    })
    expect(calls).toEqual([['confirm', 'activate']])
  })

  test('a disabled one is refused unless forced', async () => {
    const { screen, calls } = setupActions()
    await expect(screen.press('Swipe to cancel')).rejects.toThrow(/is disabled; pass \{"force":true\}/)
    expect(calls).toEqual([])
    await screen.press('Swipe to cancel', { force: true })
    expect(calls).toEqual([['cancel', 'activate']])
  })

  test('the nearest ancestor with an activate action handles a press inside it', async () => {
    const { screen, calls } = setupActions()
    expect(await screen.press('thumb')).toMatchObject({ testID: 'thumb', via: 'accessibilityAction:activate' })
    expect(calls).toEqual([['track', 'activate']])
  })

  test('onPress still wins when the element has both', async () => {
    const { screen, calls } = setupActions()
    const result = await screen.press('both')
    expect(result).not.toHaveProperty('via')
    expect(calls).toEqual([['press']])
  })

  test('{action} sends a named action, and names the ones there are when it is missing', async () => {
    const { screen, calls } = setupActions()
    expect(screen.snapshot().elements.find((e) => e.label === 'Volume')).toMatchObject({
      kind: 'view',
      actions: ['increment', 'decrement'],
    })
    await expect(screen.press('Volume')).rejects.toThrow(/has no onPress or "activate" accessibility action/)
    expect(await screen.press('Volume', { action: 'increment' })).toMatchObject({
      via: 'accessibilityAction:increment',
    })
    await screen.press('both', { action: 'activate' })
    await expect(screen.press('Volume', { action: 'magicTap' })).rejects.toThrow(
      /has no accessibility action "magicTap"; it has "increment", "decrement"/,
    )
    expect(calls).toEqual([['volume', 'increment'], ['pressable', 'activate']])
  })
})

describe('fill ambiguity', () => {
  test('the example puts index after the text, and index picks the input', async () => {
    const { screen, calls } = setup()
    await expect(screen.fill('Name', 'x')).rejects.toThrow(/\["Name","<text>",\{"index":1\}\]/)
    await screen.fill('Name', 'x', { index: 1 })
    expect(calls.map((c) => c[0])).toContain('changeText')
  })
})
