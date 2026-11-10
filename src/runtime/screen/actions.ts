// Calls an element's handlers the way React Native would after a real tap or
// keystroke, with minimal synthetic events (like Testing Library's fireEvent).
import { type Fiber, type Rect } from '../find-text-core'
import { actionFiberOf, firstHost, type Found, isSwitchFiber, pressFiberOf, propsOf } from './elements'
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
      `${describe(found.element)} is disabled; pass {"force":true} as the last argument to act on it anyway`,
    )
}

function pressTargetOf(found: Found, action: string | undefined) {
  if (action === undefined) return pressFiberOf(found)
  const fiber = actionFiberOf(found, action)
  return fiber && { fiber, via: 'accessibilityAction' as const, ancestor: fiber !== found.actions }
}

const isFn = (v: unknown) => typeof v === 'function'

/** A Switch with no onPress of its own: pressing it flips its value (anything but `true` is off). */
export const isToggle = (found: Found) =>
  !found.press &&
  !!found.change &&
  isFn(propsOf(found.change)?.onValueChange) &&
  isSwitchFiber(found.change)

const HOLD = ['onPress', 'onPressIn', 'onLongPress']

/**
 * The fiber with `onLongPress`: the element's own (down its wrapper chain), else
 * the nearest ancestor's. A hold lands on the first fiber that handles presses,
 * so the walk stops there: an inner Pressable shadows an outer onLongPress.
 */
export function longPressFiberOf(found: Found): { fiber: Fiber; ancestor: boolean } | null {
  let handlesPress = false
  for (let f: Fiber | null = found.fiber; f; f = f.child) {
    const p = propsOf(f)
    if (isFn(p?.onLongPress)) return { fiber: f, ancestor: false }
    if (p && HOLD.some((k) => isFn(p[k]))) handlesPress = true
    if (f === found.host) break
  }
  if (handlesPress) return null
  for (let f = found.fiber.return; f; f = f.return) {
    const p = propsOf(f)
    if (isFn(p?.onLongPress)) return { fiber: f, ancestor: true }
    if (p && HOLD.some((k) => isFn(p[k]))) return null
  }
  return null
}

const TAP_GESTURES = new Set(['TapGestureHandler', 'LongPressGestureHandler'])

// react-native-gesture-handler: v2 keeps `gesture.handlerName` (a composed one, `gestures`),
// v3's hook gestures `gesture.type`. Only taps and long presses stand in for a press.
function isTapGesture(g: unknown): boolean {
  if (!g || typeof g !== 'object') return false
  const x = g as { handlerName?: unknown; type?: unknown; gestures?: unknown }
  if (typeof x.handlerName === 'string' && TAP_GESTURES.has(x.handlerName)) return true
  if (typeof x.type === 'string' && TAP_GESTURES.has(x.type)) return true
  return Array.isArray(x.gestures) && x.gestures.some(isTapGesture)
}

/**
 * Whether a tap GestureDetector sits between the element and the ancestor that
 * would take the press (all the way up when `until` is null): that detector is
 * what a real tap would hit, and its callbacks run on the UI thread.
 */
function tapDetectorBetween(found: Found, until: Fiber | null): boolean {
  for (let f: Fiber | null = found.fiber; f; f = f.child) {
    if (isTapGesture(propsOf(f)?.gesture)) return true
    if (f === found.host) break
  }
  for (let f = found.fiber.return; f && f !== until; f = f.return) {
    const p = propsOf(f)
    if (isTapGesture(p?.gesture)) return true
    if (!until && p && HOLD.some((k) => isFn(p[k]))) break
  }
  return false
}

const GESTURE_NOTE =
  'it is inside a react-native-gesture-handler GestureDetector, whose callbacks run on the UI thread and cannot be fired from here, so use a real tap (agent-device)'

const gestureNote = (found: Found) => (tapDetectorBetween(found, null) ? `; ${GESTURE_NOTE}` : '')

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
    handler(found.change as Fiber, 'onValueChange')?.(now !== true)
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
  if (ancestor && action === undefined && tapDetectorBetween(found, fiber))
    throw new Error(
      `${describe(found.element)} has no onPress of its own, and ${GESTURE_NOTE}; pressing the ancestor that has one would do something else`,
    )
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

// The native Picker reads its items from `props.children` (React elements) and never
// renders a Picker.Item of its own; an item is an element with a value and a label.
function itemsOfChildren(children: unknown, out: Item[] = []): Item[] {
  if (Array.isArray(children)) for (const c of children) itemsOfChildren(c, out)
  else if (children && typeof children === 'object') {
    const p = (children as { props?: Record<string, unknown> }).props
    if (p && has(p.value) && typeof p.label === 'string') out.push({ value: p.value, label: p.label })
    else if (p) itemsOfChildren(p.children, out)
  }
  return out
}

// Picker.Item children, else (the web build renders them) fibers with a label and a value.
function pickerItems(fiber: Fiber): Item[] {
  const items = itemsOfChildren(propsOf(fiber)?.children)
  if (items.length) return items
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

/** A Slider (`@react-native-community/slider`): its own props or its native host say so. */
export function isSlider(fiber: Fiber): boolean {
  const p = propsOf(fiber) as Record<string, unknown>
  if (['onSlidingStart', 'onSlidingComplete', 'minimumValue', 'maximumValue', 'step'].some((k) => k in p))
    return true
  const own = firstHost(fiber)
  return !!own && /Slider/.test(String(own.type))
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
 * Calls the control's handlers with a value of the type it holds, in the order
 * its native side does: a Slider's `onSlidingStart`, `onValueChange`, then
 * `onSlidingComplete`; a SegmentedControl's `onChange` before `onValueChange`; a
 * Picker's item index along with the value. Throws when the value does not fit.
 */
export function setControlValue(found: Found, value: unknown, options: { force?: boolean } = {}): void {
  const fiber = found.change
  const what = describe(found.element)
  if (!fiber)
    throw new Error(`${what} has no onValueChange (a Switch, Slider, Picker or SegmentedControl has one)`)
  refuseDisabled(found, fiber, options.force)
  const p = propsOf(fiber) as Record<string, unknown>
  const call = (name: string, ...args: unknown[]) => handler(fiber, name)?.(...args)
  if (isSwitchFiber(fiber)) {
    if (typeof value !== 'boolean') throw new Error(`${what} is a switch: pass true or false; got ${JSON.stringify(value)}`)
    return void call('onValueChange', value)
  }
  if (Array.isArray(p.values)) {
    if (!p.values.includes(value))
      throw new Error(`${what} takes one of ${list(p.values)}; got ${JSON.stringify(value)}`)
    const selectedSegmentIndex = p.values.indexOf(value)
    call('onChange', event({ value, selectedSegmentIndex }))
    return void call('onValueChange', value)
  }
  const items = pickerItems(fiber)
  if (items.length || 'selectedValue' in p) {
    const index = items.findIndex((i) => i.value === value)
    if (!items.length) throw new Error(`${what} is a picker but no Picker.Item children could be read`)
    if (index < 0)
      throw new Error(`${what} takes one of ${list(items.map((i) => i.value))}; got ${JSON.stringify(value)}`)
    return void call('onValueChange', value, index)
  }
  const current = valueOf(found)
  if (isSlider(fiber) || typeof current === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(`${what} takes a number; got ${JSON.stringify(value)}`)
    const slider = isSlider(fiber)
    // The component defaults the range to 0..1 itself, so the fiber props can omit it.
    const min = typeof p.minimumValue === 'number' ? p.minimumValue : slider ? 0 : undefined
    const max = typeof p.maximumValue === 'number' ? p.maximumValue : slider ? 1 : undefined
    if ((min !== undefined && value < min) || (max !== undefined && value > max))
      throw new Error(`${what} takes a number between ${min ?? '-∞'} and ${max ?? '∞'}; got ${value}`)
    const step = p.step
    if (typeof step === 'number' && step > 0) {
      const n = (value - (min ?? 0)) / step
      if (Math.abs(n - Math.round(n)) > 1e-6) {
        const lo = (min ?? 0) + Math.floor(n) * step
        throw new Error(`${what} moves in steps of ${step}; got ${value} (nearest: ${lo}, ${lo + step})`)
      }
    }
    call('onSlidingStart', value)
    call('onValueChange', value)
    return void call('onSlidingComplete', value)
  }
  if (typeof current === 'string' && typeof value !== 'string')
    throw new Error(`${what} takes a string; got ${JSON.stringify(value)}`)
  call('onValueChange', value)
}
