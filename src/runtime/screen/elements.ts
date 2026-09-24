// Turns React's committed fiber tree into the elements an agent can see and
// act on. No react-native imports, so it tests with fake trees and bundles on web.
import {
  type Fiber,
  HOST_COMPONENT,
  type Rect,
  measureHost,
  textOf,
} from '../find-text-core'

export type ElementKind = 'button' | 'input' | 'text' | 'view'

export type ScreenElement = {
  kind: ElementKind
  text?: string
  testID?: string
  label?: string
  placeholder?: string
  value?: string
  editable?: boolean
  role?: string
  disabled?: boolean
  rect: Rect | null
  /** Only in `screen.snapshot({ all: true })`. */
  onScreen?: boolean
}

/** An element plus the fibers the actions need. */
export type Found = {
  element: ScreenElement
  onScreen: boolean
  /** Outermost fiber of the element. */
  fiber: Fiber
  /** First host component at or under it: what gets measured. */
  host: Fiber
  /** Outermost fiber with `onPress`, when the element is a button. */
  press: Fiber | null
  /** Outermost fiber with text-input handlers, when the element is an input. */
  input: Fiber | null
  maxLength?: number
}

export type Window = { width: number; height: number }

type Props = Record<string, unknown>

type Rec = Found & {
  parent: Rec | null
  parts: { host: Fiber; text: string }[]
}

const propsOf = (fiber: Fiber): Props | null =>
  fiber.memoizedProps && typeof fiber.memoizedProps === 'object'
    ? (fiber.memoizedProps as Props)
    : null

const isFn = (v: unknown) => typeof v === 'function'

export const isInputProps = (p: Props) =>
  isFn(p.onChangeText) ||
  (isFn(p.onChange) &&
    ('value' in p || 'defaultValue' in p || 'placeholder' in p))

const interesting = (p: Props) =>
  isFn(p.onPress) || isInputProps(p) || typeof p.testID === 'string'

// Icon fonts (Ionicons and friends) render glyphs from the private use area.
const ICON_GLYPHS = /[\uE000-\uF8FF]/g

function firstHost(fiber: Fiber): Fiber | null {
  if (fiber.tag === HOST_COMPONENT) return fiber
  const stack = fiber.child ? [fiber.child] : []
  while (stack.length) {
    const f = stack.pop() as Fiber
    if (f.tag === HOST_COMPONENT) return f
    if (f.sibling) stack.push(f.sibling)
    if (f.child) stack.push(f.child)
  }
  return null
}

function absorb(rec: Rec, fiber: Fiber, p: Props) {
  const e = rec.element
  if (!rec.input && isInputProps(p)) rec.input = fiber
  if (!rec.press && isFn(p.onPress)) rec.press = fiber
  const fill = (key: 'testID' | 'label' | 'role' | 'placeholder', v: unknown) => {
    if (e[key] === undefined && typeof v === 'string') e[key] = v
  }
  fill('testID', p.testID)
  fill('label', p.accessibilityLabel ?? p['aria-label'])
  fill('role', p.accessibilityRole ?? p.role)
  fill('placeholder', p.placeholder)
  if (e.value === undefined && ('value' in p || 'defaultValue' in p)) {
    const v = p.value ?? p.defaultValue
    if (v != null) e.value = String(v)
  }
  if (rec.maxLength === undefined && typeof p.maxLength === 'number')
    rec.maxLength = p.maxLength
  if (p.editable === false || p.readOnly === true) e.editable = false
  const state = p.accessibilityState as { disabled?: boolean } | undefined
  if (p.disabled === true || state?.disabled === true || p['aria-disabled'] === true)
    e.disabled = true
}

function isOnScreen(rect: Rect | null, window: Window): boolean {
  return (
    !!rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x < window.width &&
    rect.y < window.height &&
    rect.x + rect.width > 0 &&
    rect.y + rect.height > 0
  )
}

const round = (r: Rect | null): Rect | null =>
  r && {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  }

const handles = (control: Fiber | null, p: Props, name: string) =>
  !!control && isFn(p[name]) && propsOf(control)?.[name] === p[name]

/** The nearest enclosing control whose handler this fiber was handed down. */
function sameControl(rec: Rec | null, p: Props): Rec | null {
  for (let r = rec; r; r = r.parent) {
    if (!r.press && !r.input) continue
    const same =
      handles(r.press, p, 'onPress') ||
      handles(r.input, p, 'onChangeText') ||
      handles(r.input, p, 'onChange')
    return same ? r : null
  }
  return null
}

// Props usually reach the host through a chain of wrappers.
function absorbChain(rec: Rec, fiber: Fiber, host: Fiber) {
  for (let f: Fiber | null = fiber; f; f = f.child) {
    const p = propsOf(f)
    if (p) absorb(rec, f, p)
    if (f === host) break
  }
}

/**
 * Every element outside inactive screens, in tree order. One element per
 * control: a Pressable and the View it renders are one button, a field
 * component handing its onChangeText to a TextInput is one input (measured at
 * the TextInput), and the outermost fiber with a handler is the one actions call.
 */
export function collectElements(roots: Fiber[], window: Window): Found[] {
  const byHost = new Map<Fiber, Rec>()
  const order: Rec[] = []

  const recFor = (fiber: Fiber, host: Fiber, parent: Rec | null): Rec => {
    let rec = byHost.get(host)
    if (rec) return rec
    rec = {
      element: { kind: 'view', rect: null },
      onScreen: false,
      fiber,
      host,
      press: null,
      input: null,
      parent,
      parts: [],
    }
    absorbChain(rec, fiber, host)
    byHost.set(host, rec)
    order.push(rec)
    return rec
  }

  // Buttons own the text beneath them; inputs don't (a field's label stays text).
  const buttonOf = (rec: Rec | null) => {
    for (let r = rec; r; r = r.parent) if (r.press) return r
    return null
  }

  type Item = { fiber: Fiber; rec: Rec | null }
  const stack: Item[] = roots.map((fiber) => ({ fiber, rec: null }))
  while (stack.length) {
    const { fiber, rec: parentRec } = stack.pop() as Item
    if (fiber.sibling) stack.push({ fiber: fiber.sibling, rec: parentRec })
    const p = propsOf(fiber)
    // react-native-screens keeps inactive tabs and screens mounted.
    if (fiber.tag === HOST_COMPONENT && p?.activityState === 0) continue

    let rec = parentRec
    if (p && interesting(p)) {
      const host = firstHost(fiber)
      const same = host && !byHost.has(host) ? sameControl(parentRec, p) : null
      if (host && same) {
        byHost.set(host, same)
        same.host = host
        absorbChain(same, fiber, host)
        rec = same
      } else if (host) {
        rec = recFor(fiber, host, parentRec)
        absorb(rec, fiber, p)
      }
    }
    const found = textOf(fiber)
    if (found?.host) {
      const owner = buttonOf(rec) ?? recFor(found.host, found.host, rec)
      const last = owner.parts[owner.parts.length - 1]
      if (last?.host === found.host) last.text += found.text
      else owner.parts.push({ host: found.host, text: found.text })
    }
    if (fiber.child) stack.push({ fiber: fiber.child, rec })
  }

  for (const rec of order) {
    const e = rec.element
    const text = rec.parts
      .map((part) => part.text.replace(ICON_GLYPHS, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ')
    if (text) e.text = text
    e.kind = rec.input
      ? 'input'
      : rec.press
        ? 'button'
        : rec.parts.length
          ? 'text'
          : 'view'
    if (e.kind === 'input' && e.editable === undefined) e.editable = true
    const rect = measureHost(rec.host)
    e.rect = round(rect)
    rec.onScreen = isOnScreen(rect, window)
  }
  // A text-only element whose glyphs were all icons has nothing to show.
  return order.filter(
    (rec) => rec.element.kind !== 'text' || rec.element.text !== undefined,
  )
}

/** The fiber `press` should call: the element's own, or the nearest ancestor's. */
export function pressFiberOf(found: Found): Fiber | null {
  if (found.press) return found.press
  for (let f = found.fiber.return; f; f = f.return) {
    const p = propsOf(f)
    if (p && isFn(p.onPress)) return f
  }
  return null
}

export { propsOf }
