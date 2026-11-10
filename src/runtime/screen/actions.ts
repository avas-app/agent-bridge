// Calls an element's handlers the way React Native would after a real tap or
// keystroke, with minimal synthetic events (like Testing Library's fireEvent).
import { type Fiber, type Rect } from '../find-text-core'
import { actionFiberOf, type Found, pressFiberOf, propsOf } from './elements'
import { describe } from './targets'

type Handler = (...args: unknown[]) => unknown

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

function refuseDisabled(found: Found, fiber: Fiber, force?: boolean) {
  if (!force && (found.element.disabled || disabledProps(fiber)))
    throw new Error(
      `${describe(found.element)} is disabled; pass {"force":true} as the last argument to press anyway`,
    )
}

function pressTargetOf(found: Found, action: string | undefined) {
  if (action === undefined) return pressFiberOf(found)
  const fiber = actionFiberOf(found, action)
  return fiber && { fiber, via: 'accessibilityAction' as const, ancestor: fiber !== found.actions }
}

const isFn = (v: unknown) => typeof v === 'function'

/** A Switch-like control with no onPress of its own: pressing it flips its value. */
export const isToggle = (found: Found) =>
  !found.press && !!found.change && typeof propsOf(found.change)?.value === 'boolean'

/** The fiber with `onLongPress`: the element's own (down its wrapper chain), else the nearest ancestor's. */
export function longPressFiberOf(found: Found): { fiber: Fiber; ancestor: boolean } | null {
  for (let f: Fiber | null = found.fiber; f; f = f.child) {
    if (isFn(propsOf(f)?.onLongPress)) return { fiber: f, ancestor: false }
    if (f === found.host) break
  }
  for (let f = found.fiber.return; f; f = f.return)
    if (isFn(propsOf(f)?.onLongPress)) return { fiber: f, ancestor: true }
  return null
}

// GestureDetector keeps its Gesture.Tap() callbacks as worklets that run on the UI thread.
function insideGestureDetector(found: Found): boolean {
  const has = (f: Fiber) => {
    const g = propsOf(f)?.gesture as Record<string, unknown> | null | undefined
    return !!g && typeof g === 'object' && ('handlers' in g || 'gestures' in g || 'handlerName' in g)
  }
  for (let f: Fiber | null = found.fiber; f; f = f.child) {
    if (has(f)) return true
    if (f === found.host) break
  }
  for (let f = found.fiber.return; f; f = f.return) if (has(f)) return true
  return false
}

const gestureNote = (found: Found) =>
  insideGestureDetector(found)
    ? '; it is a react-native-gesture-handler GestureDetector, whose callbacks run on the UI thread and cannot be fired from JS, so use a real tap (agent-device)'
    : ''

/**
 * Presses the element, or the nearest ancestor that handles presses. With no
 * onPress it sends the `activate` accessibility action, as a screen reader's
 * double tap does; `action` sends that named action instead. Returns how the
 * press was delivered.
 */
export function pressElement(
  found: Found,
  options: { force?: boolean; action?: string; long?: boolean } = {},
): string {
  const { action } = options
  if (options.long) return longPress(found, options)
  if (action === undefined && isToggle(found)) {
    refuseDisabled(found, found.change as Fiber, options.force)
    const now = propsOf(found.change as Fiber)?.value
    handler(found.change as Fiber, 'onValueChange')?.(!now)
    return 'onValueChange'
  }
  const target = pressTargetOf(found, action)
  if (!target) {
    const names = found.element.actions ?? []
    const has = names.length ? `; it has ${names.map((a) => JSON.stringify(a)).join(', ')}` : ''
    throw new Error(
      action === undefined
        ? `${describe(found.element)} has no onPress or "activate" accessibility action${gestureNote(found)}`
        : `${describe(found.element)} has no accessibility action ${JSON.stringify(action)}${has}`,
    )
  }
  const { fiber, via, ancestor } = target
  const from = ancestor ? 'ancestor:' : ''
  refuseDisabled(found, fiber, options.force)
  if (via === 'accessibilityAction') {
    const actionName = action ?? 'activate'
    handler(fiber, 'onAccessibilityAction')?.(event({ actionName }))
    return `${from}accessibilityAction:${actionName}`
  }
  const e = () => pressEvent(found)
  // A quick tap's order: Pressability holds onPressOut back until the
  // minimum press duration has passed, so onPress comes first.
  handler(fiber, 'onPressIn')?.(e())
  handler(fiber, 'onPress')?.(e())
  handler(fiber, 'onPressOut')?.(e())
  return ancestor ? 'ancestor' : 'onPress'
}

const pressEvent = (found: Found) => {
  const { x, y } = center(found.element.rect)
  return event({
    locationX: found.element.rect ? found.element.rect.width / 2 : 0,
    locationY: found.element.rect ? found.element.rect.height / 2 : 0,
    pageX: x,
    pageY: y,
    timestamp: Date.now(),
  })
}

// A held press: onPressIn, then onLongPress after the delay, then onPressOut on release (no onPress).
function longPress(found: Found, options: { force?: boolean; action?: string }): string {
  if (options.action !== undefined)
    throw new Error('{long:true} and {action} cannot be combined: long presses call onLongPress, actions send an accessibility action')
  const target = longPressFiberOf(found)
  if (!target)
    throw new Error(`${describe(found.element)} has no onLongPress${gestureNote(found)}`)
  refuseDisabled(found, target.fiber, options.force)
  handler(target.fiber, 'onPressIn')?.(pressEvent(found))
  handler(target.fiber, 'onLongPress')?.(pressEvent(found))
  handler(target.fiber, 'onPressOut')?.(pressEvent(found))
  return target.ancestor ? 'ancestor:onLongPress' : 'onLongPress'
}

type Item = { value: unknown; label?: string }

// Picker.Item children: elements with a label and a value.
function pickerItems(fiber: Fiber): Item[] {
  const items: Item[] = []
  const stack = fiber.child ? [fiber.child] : []
  while (stack.length) {
    const f = stack.pop() as Fiber
    if (f.sibling) stack.push(f.sibling)
    if (f.child) stack.push(f.child)
    const p = propsOf(f)
    if (p && has(p.value) && typeof p.label === 'string') items.push({ value: p.value, label: p.label })
  }
  return items
}

/** The value a Switch, Slider, Picker or SegmentedControl shows now. */
export function valueOf(found: Found): unknown {
  const p = found.change && propsOf(found.change)
  if (!p) return undefined
  if (has(p.value)) return p.value
  if (has(p.selectedValue)) return p.selectedValue
  if (Array.isArray(p.values) && typeof p.selectedIndex === 'number') return p.values[p.selectedIndex]
  return undefined
}

const list = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join(', ')

/**
 * Calls the control's `onValueChange` with a value of the type it holds (a
 * Slider's `onSlidingComplete` after it, a Picker's item index along with
 * it). Throws when the value does not fit the control.
 */
export function setControlValue(found: Found, value: unknown, options: { force?: boolean } = {}): void {
  const fiber = found.change
  const what = describe(found.element)
  if (!fiber)
    throw new Error(`${what} has no onValueChange (a Switch, Slider, Picker or SegmentedControl has one)`)
  refuseDisabled(found, fiber, options.force)
  const p = propsOf(fiber) as Record<string, unknown>
  const current = valueOf(found)
  const call = (...args: unknown[]) => handler(fiber, 'onValueChange')?.(...args)
  if (typeof current === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${what} is a switch: pass true or false; got ${JSON.stringify(value)}`)
    return void call(value)
  }
  const items = pickerItems(fiber)
  if (Array.isArray(p.values)) {
    if (!p.values.includes(value))
      throw new Error(`${what} takes one of ${list(p.values)}; got ${JSON.stringify(value)}`)
    call(value)
    handler(fiber, 'onChange')?.(
      event({ value, selectedSegmentIndex: p.values.indexOf(value) }),
    )
    return
  }
  if (items.length) {
    const index = items.findIndex((i) => i.value === value)
    if (index < 0)
      throw new Error(`${what} takes one of ${list(items.map((i) => i.value))}; got ${JSON.stringify(value)}`)
    return void call(value, index)
  }
  const { minimumValue: min, maximumValue: max } = p
  if (typeof current === 'number' || typeof min === 'number' || typeof max === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(`${what} takes a number; got ${JSON.stringify(value)}`)
    if ((typeof min === 'number' && value < min) || (typeof max === 'number' && value > max))
      throw new Error(`${what} takes a number between ${min ?? '-∞'} and ${max ?? '∞'}; got ${value}`)
    call(value)
    handler(fiber, 'onSlidingComplete')?.(value)
    return
  }
  if (typeof current === 'string' && typeof value !== 'string')
    throw new Error(`${what} takes a string; got ${JSON.stringify(value)}`)
  call(value)
}
