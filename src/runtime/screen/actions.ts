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

const has = (v: unknown) => v !== undefined && v !== null

/** Whether the input keeps its own text: no `value` prop on it or the host under it. */
export const isUncontrolled = (found: Found) =>
  !!found.input && !has(propsOf(found.input)?.value) && !has(propsOf(found.host)?.value)

type NativeProps = { setNativeProps?: (p: object) => void }

// An input with no `value` prop keeps its text natively, so write it there.
// Fabric hosts hold the instance at stateNode.canonical.publicInstance (null until first used).
function setNativeText(found: Found, text: string): boolean {
  for (const fiber of [found.host, found.input]) {
    const node = fiber?.stateNode as
      | (NativeProps & { canonical?: { publicInstance?: NativeProps | null } })
      | null
      | undefined
    for (const target of [node, node?.canonical?.publicInstance]) {
      if (target && typeof target.setNativeProps === 'function') {
        target.setNativeProps({ text })
        return true
      }
    }
  }
  const dom = found.host.stateNode as { value?: unknown } | null
  if (dom && typeof dom === 'object' && 'value' in dom) {
    dom.value = text
    return true
  }
  return false
}

// A key per user-perceived character, so an emoji is one keystroke.
const keysOf = (text: string): string[] => {
  const Segmenter = (Intl as { Segmenter?: new (l?: string, o?: object) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter
  return Segmenter
    ? Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (x) => x.segment)
    : Array.from(text)
}

/**
 * Types `text` into an input, replacing what is there ("" clears it). `type`
 * enters one key at a time, as a keyboard does, calling `between` after each
 * so the app can render, and `again` to get the input after that render.
 * Returns the text it filled (after `maxLength`) and whether the text was
 * written natively (null for a controlled input).
 */
export async function fillInput(
  found: Found,
  text: string,
  options: {
    submit?: boolean
    type?: boolean
    between?: () => Promise<void>
    again?: (found: Found) => Found
  } = {},
): Promise<{ filled: string; native: boolean | null }> {
  if (!found.input) throw new Error(`${describe(found.element)} is not a text input`)
  if (found.element.editable === false)
    throw new Error(`${describe(found.element)} is not editable`)
  const { maxLength } = found
  const value =
    maxLength === undefined ? text : text.slice(0, Math.max(0, maxLength))
  const uncontrolled = isUncontrolled(found)
  let native: boolean | null = uncontrolled ? false : null
  let current = found
  // react-dom reads event.target.value; React Native reads nativeEvent.text.
  const change = (next: string) => {
    const target = { value: next }
    if (uncontrolled && setNativeText(current, next)) native = true
    const input = current.input as Fiber
    handler(input, 'onChangeText')?.(next)
    eventCount += 1
    handler(input, 'onChange')?.(event({ text: next, eventCount }, target))
  }
  const target = { value }
  handler(found.input, 'onFocus')?.(event({ text: value }, target))
  if (options.type && value) {
    const keys = keysOf(value)
    let typed = ''
    for (const key of keys) {
      typed += key
      handler(current.input as Fiber, 'onKeyPress')?.(event({ key: key === '\n' ? 'Enter' : key }))
      change(typed)
      if (options.between) await options.between()
      if (options.again) current = options.again(current)
    }
  } else change(value)
  const input = current.input as Fiber
  if (options.submit) handler(input, 'onSubmitEditing')?.(event({ text: value }, target))
  handler(input, 'onEndEditing')?.(event({ text: value }, target))
  handler(input, 'onBlur')?.(event({ text: value }, target))
  return { filled: value, native }
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
  return fiber && { fiber, via: 'accessibilityAction' as const, ancestor: fiber !== found.actions }
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
  const { fiber, via, ancestor } = target
  const from = ancestor ? 'ancestor:' : ''
  if (!options.force && (found.element.disabled || disabledProps(fiber)))
    throw new Error(
      `${describe(found.element)} is disabled; pass {"force":true} as the last argument to press anyway`,
    )
  if (via === 'accessibilityAction') {
    const actionName = action ?? 'activate'
    handler(fiber, 'onAccessibilityAction')?.(event({ actionName }))
    return `${from}accessibilityAction:${actionName}`
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
  return ancestor ? 'ancestor' : 'onPress'
}
