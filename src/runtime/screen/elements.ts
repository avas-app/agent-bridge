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
  /** `accessibilityState` / `aria-*`, and a Switch's `value`. */
  checked?: boolean | 'mixed'
  selected?: boolean
  expanded?: boolean
  rect: Rect | null
  /** Only in `screen.snapshot({ all: true })`. */
  onScreen?: boolean
  /** Only in `screen.snapshot({ all: true })`: on a screen the user can't reach. */
  hidden?: boolean
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
  /**
   * On a screen the user can't reach: an unfocused tab or stack screen, under
   * an open modal, `display: none`, or hidden from accessibility.
   */
  hidden: boolean
  /** The nearest enclosing scrollable, or the element itself when it is one. */
  scroller: Scrollable | null
}

/** A ScrollView, FlatList, FlashList (or a scrolling DOM element) and its host. */
export type Scrollable = {
  host: Fiber
  /** Every fiber over this host with scroll methods, outermost first. */
  fibers: Fiber[]
  hidden: boolean
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

type Node = Record<string, unknown>

const nodeOf = (fiber: Fiber): Node | null => {
  const n = fiber.stateNode
  return n && typeof n === 'object' ? (n as Node) : null
}

const SCROLL_METHODS = ['scrollTo', 'scrollToOffset']

/** Whether the fiber's instance (or host node) can be told to scroll. */
function scrolls(fiber: Fiber): boolean {
  const node = nodeOf(fiber)
  if (!node || !SCROLL_METHODS.some((m) => isFn(node[m]))) return false
  // DOM-like nodes all have scrollTo; only ones with overflow scroll.
  if (typeof node.scrollHeight === 'number' && typeof node.clientHeight === 'number')
    return (
      node.scrollHeight > node.clientHeight + 1 ||
      (node.scrollWidth as number) > (node.clientWidth as number) + 1
    )
  return true
}

const flatStyle = (style: unknown): Props => {
  const out: Props = {}
  const walk = (s: unknown) => {
    if (Array.isArray(s)) s.forEach(walk)
    else if (s && typeof s === 'object') Object.assign(out, s)
  }
  walk(style)
  return out
}

// What React Native and react-native-screens say about a subtree the user can't
// reach: inactive screens (`activityState` 0), `display: none` (react-navigation
// hides unfocused tabs that way), and accessibility hiding.
const hiddenBy = (p: Props) =>
  p.activityState === 0 ||
  flatStyle(p.style).display === 'none' ||
  p['aria-hidden'] === true ||
  p.accessibilityElementsHidden === true ||
  p.importantForAccessibility === 'no-hide-descendants'

const MODAL_HOSTS = new Set(['RCTModalHostView', 'ModalHostView'])
const SCREEN_STACK = 'RNSScreenStack'
const STACK_SCREENS = new Set(['RNSScreen', 'RNSModalScreen'])

/** A native stack shows only its last screen; the ones beneath stay mounted. */
function coveredScreens(stack: Fiber): Fiber[] {
  const screens: Fiber[] = []
  const todo = stack.child ? [stack.child] : []
  while (todo.length) {
    const f = todo.pop() as Fiber
    if (f.sibling) todo.push(f.sibling)
    if (f.tag === HOST_COMPONENT && STACK_SCREENS.has(f.type as string)) {
      if (propsOf(f)?.activityState !== 0) screens.push(f)
    } else if (f.child) todo.push(f.child)
  }
  return screens.slice(0, -1)
}

const within = (fiber: Fiber, ancestor: Fiber) => {
  for (let f: Fiber | null = fiber; f; f = f.return) if (f === ancestor) return true
  return false
}

const SWITCH_HOSTS = new Set(['RCTSwitch', 'AndroidSwitch'])

const isFn = (v: unknown) => typeof v === 'function'

export const isInputProps = (p: Props) =>
  isFn(p.onChangeText) ||
  (isFn(p.onChange) &&
    typeof p.value !== 'boolean' &&
    ('value' in p || 'defaultValue' in p || 'placeholder' in p))

// A view named only by an accessibility label is still something on screen.
const labelOf = (p: Props) => p.accessibilityLabel ?? p['aria-label']

const interesting = (p: Props) =>
  isFn(p.onPress) ||
  isFn(p.onValueChange) ||
  isInputProps(p) ||
  typeof p.testID === 'string' ||
  typeof labelOf(p) === 'string'

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
  fill('label', labelOf(p))
  fill('role', p.accessibilityRole ?? p.role)
  fill('placeholder', p.placeholder)
  // A Switch's boolean value is its checked state, not a value to read.
  const isSwitch =
    SWITCH_HOSTS.has(fiber.type as string) ||
    (p.accessibilityRole ?? p.role ?? e.role) === 'switch'
  if (isSwitch && typeof p.value === 'boolean') {
    if (e.checked === undefined) e.checked = p.value
    if (e.role === undefined) e.role = 'switch'
  } else if (
    e.value === undefined &&
    !(typeof p.value === 'boolean' && isFn(p.onValueChange)) &&
    ('value' in p || 'defaultValue' in p)
  ) {
    const v = p.value ?? p.defaultValue
    if (v != null) e.value = String(v)
  }
  if (rec.maxLength === undefined && typeof p.maxLength === 'number')
    rec.maxLength = p.maxLength
  if (p.editable === false || p.readOnly === true) e.editable = false
  const state = p.accessibilityState as
    | { disabled?: boolean; checked?: boolean | 'mixed'; selected?: boolean; expanded?: boolean }
    | undefined
  const checked = state?.checked ?? p['aria-checked']
  if (e.checked === undefined && (typeof checked === 'boolean' || checked === 'mixed'))
    e.checked = checked
  const flag = (key: 'selected' | 'expanded') => {
    const v = state?.[key] ?? p[`aria-${key}`]
    if (e[key] === undefined && typeof v === 'boolean') e[key] = v
  }
  flag('selected')
  flag('expanded')
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
 * Every element in tree order, with `hidden` set for the ones on screens the
 * user can't reach. One element per control: a Pressable and the View it
 * renders are one button, a field component handing its onChangeText to a
 * TextInput is one input (measured at the TextInput), and the outermost fiber
 * with a handler is the one actions call.
 */
export function collectScreen(
  roots: Fiber[],
  window: Window,
): { found: Found[]; scrollables: Scrollable[] } {
  const byHost = new Map<Fiber, Rec>()
  const order: Rec[] = []
  const scrollByHost = new Map<Fiber, Scrollable>()
  const covered = new Set<Fiber>()
  let topModal: Fiber | null = null

  const recFor = (
    fiber: Fiber,
    host: Fiber,
    parent: Rec | null,
    hidden: boolean,
    scroller: Scrollable | null,
  ): Rec => {
    let rec = byHost.get(host)
    if (rec) return rec
    rec = {
      element: { kind: 'view', rect: null },
      onScreen: false,
      fiber,
      host,
      press: null,
      input: null,
      hidden,
      scroller,
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

  // Nested Text is one string: `<Text>Finding<Text>...</Text></Text>` reads
  // "Finding..." and belongs to the outermost text host.
  const textHost = (host: Fiber): Fiber => {
    let h = host
    for (;;) {
      let up = h.return
      while (up && up.tag !== HOST_COMPONENT) up = up.return
      if (!up) return h
      if (h.type !== 'RCTVirtualText') return h
      h = up
    }
  }

  type Item = {
    fiber: Fiber
    rec: Rec | null
    hidden: boolean
    scroller: Scrollable | null
  }
  const stack: Item[] = roots.map((fiber) => ({
    fiber,
    rec: null,
    hidden: false,
    scroller: null,
  }))
  while (stack.length) {
    const item = stack.pop() as Item
    const { fiber, rec: parentRec } = item
    if (fiber.sibling) stack.push({ ...item, fiber: fiber.sibling })
    const p = propsOf(fiber)
    let { hidden, scroller } = item
    if (p && hiddenBy(p)) hidden = true
    if (covered.has(fiber)) hidden = true
    if (fiber.tag === HOST_COMPONENT) {
      if (fiber.type === SCREEN_STACK)
        for (const screen of coveredScreens(fiber)) covered.add(screen)
      if (!hidden && MODAL_HOSTS.has(fiber.type as string)) topModal = fiber
    }
    if (scrolls(fiber)) {
      const host = firstHost(fiber)
      if (host) {
        let found = scrollByHost.get(host)
        if (!found) {
          found = { host, fibers: [], hidden }
          scrollByHost.set(host, found)
        }
        found.fibers.push(fiber)
        scroller = found
      }
    }

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
        rec = recFor(fiber, host, parentRec, hidden, scroller)
        absorb(rec, fiber, p)
      }
    }
    const found = textOf(fiber)
    if (found?.host) {
      const host = textHost(found.host)
      const owner = buttonOf(rec) ?? recFor(host, host, rec, hidden, scroller)
      const last = owner.parts[owner.parts.length - 1]
      if (last?.host === host) last.text += found.text
      else owner.parts.push({ host, text: found.text })
    }
    if (fiber.child) stack.push({ fiber: fiber.child, rec, hidden, scroller })
  }

  // Under an open modal, only the top-most modal's content can be touched.
  const modal = topModal as Fiber | null
  const covers = (host: Fiber) => !!modal && !within(host, modal)
  for (const scrollable of scrollByHost.values())
    scrollable.hidden ||= covers(scrollable.host)

  for (const rec of order) {
    const e = rec.element
    rec.hidden ||= covers(rec.host)
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
  return {
    found: order.filter(
      (rec) => rec.element.kind !== 'text' || rec.element.text !== undefined,
    ),
    scrollables: [...scrollByHost.values()],
  }
}

export const collectElements = (roots: Fiber[], window: Window): Found[] =>
  collectScreen(roots, window).found

/** What a user could touch: not hidden behind another screen. */
export const focused = (found: Found[]): Found[] => found.filter((f) => !f.hidden)

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
