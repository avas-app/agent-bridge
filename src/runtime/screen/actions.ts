// Calls an element's handlers the way React Native would after a real tap or
// keystroke, with minimal synthetic events (like Testing Library's fireEvent).
import { type Fiber, type Rect } from '../find-text-core'
import { actionFiberOf, type Found, pressFiberOf, propsOf } from './elements'
import { describe } from './targets'

type Handler = (event?: unknown) => unknown

const handler = (fiber: Fiber, name: string): Handler | null => {
  const fn = propsOf(fiber)?.[name]
  return typeof fn === 'function' ? (fn as Handler) : null
}

const noop = () => {}
const event = (nativeEvent: Record<string, unknown>, target?: unknown) => ({
  nativeEvent,
  target,
  currentTarget: target,
  timeStamp: Date.now(),
  preventDefault: noop,
  stopPropagation: noop,
  isDefaultPrevented: () => false,
  isPropagationStopped: () => false,
  persist: noop,
})

let eventCount = 0

/** Types `text` into an input. Returns the text it filled (after `maxLength`). */
export function fillInput(
  found: Found,
  text: string,
  options: { submit?: boolean } = {},
): string {
  const input = found.input
  if (!input) throw new Error(`${describe(found.element)} is not a text input`)
  if (found.element.editable === false)
    throw new Error(`${describe(found.element)} is not editable`)
  const { maxLength } = found
  const value =
    maxLength === undefined ? text : text.slice(0, Math.max(0, maxLength))
  // react-dom reads event.target.value; React Native reads nativeEvent.text.
  const target = { value }
  handler(input, 'onFocus')?.(event({ text: value }, target))
  handler(input, 'onChangeText')?.(value)
  eventCount += 1
  handler(input, 'onChange')?.(event({ text: value, eventCount }, target))
  if (options.submit)
    handler(input, 'onSubmitEditing')?.(event({ text: value }, target))
  handler(input, 'onBlur')?.(event({ text: value }, target))
  return value
}

const center = (rect: Rect | null) =>
  rect
    ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    : { x: 0, y: 0 }

const disabledProps = (fiber: Fiber) => {
  const p = propsOf(fiber)
  const state = p?.accessibilityState as { disabled?: boolean } | undefined
  return p?.disabled === true || state?.disabled === true || p?.['aria-disabled'] === true
}

function pressTargetOf(found: Found, action: string | undefined) {
  if (action === undefined) return pressFiberOf(found)
  const fiber = actionFiberOf(found, action)
  return fiber && { fiber, via: 'accessibilityAction' as const }
}

/**
 * Presses the element, or the nearest ancestor that handles presses. With no
 * onPress it sends the `activate` accessibility action, as a screen reader's
 * double tap does; `action` sends that named action instead. Returns how the
 * press was delivered.
 */
export function pressElement(
  found: Found,
  options: { force?: boolean; action?: string } = {},
): string {
  const { action } = options
  const target = pressTargetOf(found, action)
  if (!target) {
    const names = found.element.actions ?? []
    const has = names.length ? `; it has ${names.map((a) => JSON.stringify(a)).join(', ')}` : ''
    throw new Error(
      action === undefined
        ? `${describe(found.element)} has no onPress or "activate" accessibility action`
        : `${describe(found.element)} has no accessibility action ${JSON.stringify(action)}${has}`,
    )
  }
  const { fiber, via } = target
  if (!options.force && (found.element.disabled || disabledProps(fiber)))
    throw new Error(
      `${describe(found.element)} is disabled; pass {"force":true} as the last argument to press anyway`,
    )
  if (via === 'accessibilityAction') {
    const actionName = action ?? 'activate'
    handler(fiber, 'onAccessibilityAction')?.(event({ actionName }))
    return `accessibilityAction:${actionName}`
  }
  const { x, y } = center(found.element.rect)
  const e = () =>
    event({
      locationX: found.element.rect ? found.element.rect.width / 2 : 0,
      locationY: found.element.rect ? found.element.rect.height / 2 : 0,
      pageX: x,
      pageY: y,
      timestamp: Date.now(),
    })
  // A quick tap's order: Pressability holds onPressOut back until the
  // minimum press duration has passed, so onPress comes first.
  handler(fiber, 'onPressIn')?.(e())
  handler(fiber, 'onPress')?.(e())
  handler(fiber, 'onPressOut')?.(e())
  return 'onPress'
}
