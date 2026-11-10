import { describe, expect, test } from 'bun:test'

import { createScreen } from '..'
import type { Fiber } from '../../find-text-core'
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
    expect(await screen.press('thumb')).toMatchObject({ testID: 'thumb', via: 'ancestor:accessibilityAction:activate' })
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

describe('press and text ownership', () => {
  function setupScreen() {
    const calls: string[] = []
    const root = tree(
      host(),
      // A screen-wide tap-to-dismiss-keyboard wrapper around a form and a button.
      pressable(
        { onPress: () => calls.push('dismiss') },
        rnText('Sign in'),
        textInput({ placeholder: 'Email', value: '', onChangeText: () => {} }),
        rnText('Forgot your password?'),
        pressable({ onPress: () => calls.push('submit'), testID: 'go' }, rnText('Go')),
      ),
      // A normal card: text inside owns the press, nothing nested.
      pressable({ onPress: () => calls.push('card'), testID: 'card' }, rnText('Open card')),
    )
    return { screen: createScreen({ roots: () => [root], window: () => WINDOW }), calls }
  }

  test('a pressable holding inputs or other pressables is not one big button', () => {
    const { screen } = setupScreen()
    const { elements } = screen.snapshot()
    const buttons = elements.filter((e) => e.kind === 'button' && e.text).map((e) => e.text)
    expect(buttons).toEqual(['Go', 'Open card'])
    expect(elements.map((e) => e.text).filter(Boolean)).toContain('Forgot your password?')
  })

  test('pressing loose text under it says the handler was an ancestor\'s', async () => {
    const { screen, calls } = setupScreen()
    const result = await screen.press('Forgot your password?')
    expect(result).toMatchObject({ via: 'ancestor' })
    expect(calls).toEqual(['dismiss'])
  })

  test('text inside a plain button still presses that button, with no via', async () => {
    const { screen, calls } = setupScreen()
    const result = await screen.press('Open card')
    expect(result).not.toHaveProperty('via')
    expect(calls).toEqual(['card'])
  })
})

describe('fill details', () => {
  function setupFill() {
    const calls: unknown[][] = []
    const native: string[] = []
    const handlers = {
      onFocus: () => calls.push(['focus']),
      onKeyPress: (e: { nativeEvent: { key: string } }) => calls.push(['key', e.nativeEvent.key]),
      onChangeText: (t: string) => calls.push(['changeText', t]),
      onSubmitEditing: () => calls.push(['submit']),
      onEndEditing: () => calls.push(['end']),
      onBlur: () => calls.push(['blur']),
    }
    const uncontrolled = textInput({ ...handlers, testID: 'free', defaultValue: 'old' })
    // The host instance of an uncontrolled input takes native text.
    ;(uncontrolled.child as { stateNode: Record<string, unknown> }).stateNode.setNativeProps = (p: { text: string }) =>
      native.push(p.text)
    const controlled = textInput({ ...handlers, testID: 'bound', value: 'x' })
    const root = tree(host(), uncontrolled, controlled)
    return { screen: createScreen({ roots: () => [root], window: () => WINDOW }), calls, native }
  }

  test('an uncontrolled input gets its native text set, and reports the real value', async () => {
    const { screen, native } = setupFill()
    const r = await screen.fill('free', 'new')
    expect(native).toEqual(['new'])
    expect(r.element.value).toBe('new')
  })

  test('a controlled input does not get native text', async () => {
    const { screen, native } = setupFill()
    await screen.fill('bound', 'y')
    expect(native).toEqual([])
  })

  test('onEndEditing fires after submit and before blur; "" clears', async () => {
    const { screen, calls } = setupFill()
    await screen.fill('bound', '', { submit: true })
    expect(calls.map((c) => c[0])).toEqual(['focus', 'changeText', 'submit', 'end', 'blur'])
    expect(calls[1]).toEqual(['changeText', ''])
  })

  test('{type:true} types one character at a time', async () => {
    const { screen, calls } = setupFill()
    await screen.fill('bound', 'abc', { type: true })
    expect(calls.filter((c) => c[0] === 'changeText').map((c) => c[1])).toEqual(['a', 'ab', 'abc'])
    expect(calls.filter((c) => c[0] === 'key').map((c) => c[1])).toEqual(['a', 'b', 'c'])
  })
})

const link = (content: string, onPress: () => void) => {
  const t = rnText(content, { onPress })
  ;(t.child as Fiber).type = 'RCTText'
  return t
}
const buttons = (screen: ReturnType<typeof createScreen>) =>
  screen.snapshot().elements.filter((e) => e.kind === 'button' && e.text).map((e) => e.text)
const screenOf = (...kids: Fiber[]) => {
  const root = tree(host(), ...kids)
  return createScreen({ roots: () => [root], window: () => WINDOW })
}

describe('what counts as a wrapper around controls', () => {
  test('a button made of wrapper components with different onPress closures keeps its text', () => {
    const save = tree(
      composite({ onPress: () => {} }),
      tree(composite({ onPress: () => {} }), pressable({ onPress: () => {} }, rnText('Save'))),
    )
    expect(buttons(screenOf(save))).toEqual(['Save'])
  })

  test('a card with one icon button inside keeps its title', () => {
    const icon = tree(composite({ onPress: () => {} }), pressable({ onPress: () => {} }))
    const card = pressable({ onPress: () => {} }, rnText('Title'), icon)
    expect(buttons(screenOf(card))).toEqual(['Title'])
  })

  test('a row with inline text links keeps its label', () => {
    const row = pressable(
      { onPress: () => {} },
      rnText('Accept the'),
      link('terms', () => {}),
      link('privacy policy', () => {}),
    )
    expect(buttons(screenOf(row))).toContain('Accept the')
  })

  test('a backdrop around Cancel and OK is a wrapper even when Cancel shares its handler', async () => {
    const calls: string[] = []
    const close = () => calls.push('close')
    const backdrop = pressable(
      { onPress: close },
      pressable({ onPress: close }, rnText('Cancel')),
      pressable({ onPress: () => calls.push('confirm') }, rnText('OK')),
    )
    const screen = screenOf(backdrop)
    expect(buttons(screen)).toEqual(['OK'])
    await screen.press('OK')
    expect(calls).toEqual(['confirm'])
  })

  test('a switch and a button inside a pressable make it a wrapper', () => {
    const sw = host({ value: true, onValueChange: () => {}, accessibilityRole: 'switch' })
    const wrap = pressable(
      { onPress: () => {} },
      rnText('Settings'),
      sw,
      pressable({ onPress: () => {} }, rnText('Done')),
    )
    expect(buttons(screenOf(wrap))).toEqual(['Done'])
  })
})

describe('fill on Fabric and with value: undefined', () => {
  const fabric = (native: string[]) => {
    const input = textInput({ testID: 'f', defaultValue: 'old', onChangeText: () => {} })
    ;(input.child as { stateNode: unknown }).stateNode = {
      getBoundingClientRect: () => ({ x: 20, y: 200, width: 120, height: 40 }),
      checkVisibility: () => true,
      node: {},
      canonical: { publicInstance: { setNativeProps: (p: { text: string }) => native.push(p.text) } },
    }
    return screenOf(input)
  }

  test('writes the text through the Fabric public instance', async () => {
    const native: string[] = []
    const r = await fabric(native).fill('f', 'new')
    expect(native).toEqual(['new'])
    expect(r.element.value).toBe('new')
    expect(r).not.toHaveProperty('warning')
  })

  test('does not claim a value when nothing could be written, and warns', async () => {
    const input = textInput({ testID: 'f', defaultValue: 'old', onChangeText: () => {} })
    const r = await screenOf(input).fill('f', 'new')
    expect(r.element.value).toBe('old')
    expect(r).toMatchObject({ warning: expect.stringContaining('native') })
  })

  test('a wrapper passing value={undefined} is still uncontrolled', async () => {
    const native: string[] = []
    const input = textInput({ testID: 'u', value: undefined, onChangeText: () => {} })
    ;(input.child as { stateNode: Record<string, unknown> }).stateNode.setNativeProps = (p: { text: string }) =>
      native.push(p.text)
    await screenOf(input).fill('u', 'z')
    expect(native).toEqual(['z'])
  })
})

describe('fill {type:true}', () => {
  test('lets the app render between characters, and sends Enter for a newline', async () => {
    const calls: string[] = []
    const input = textInput({
      testID: 't',
      value: '',
      onKeyPress: (e: { nativeEvent: { key: string } }) => calls.push(`key:${e.nativeEvent.key}`),
      onChangeText: (t: string) => {
        calls.push(`text:${t}`)
        setTimeout(() => calls.push('rendered'), 0)
      },
    })
    await screenOf(input).fill('t', 'a\nb', { type: true })
    expect(calls.slice(0, 5)).toEqual(['key:a', 'text:a', 'rendered', 'key:Enter', 'text:a\n'])
  })

  test('keeps an emoji in one piece', async () => {
    const keys: string[] = []
    const input = textInput({
      testID: 't',
      value: '',
      onKeyPress: (e: { nativeEvent: { key: string } }) => keys.push(e.nativeEvent.key),
      onChangeText: () => {},
    })
    await screenOf(input).fill('t', '👍🏽x', { type: true })
    expect(keys.at(-1)).toBe('x')
    expect(keys.length).toBeLessThanOrEqual(2)
  })
})
