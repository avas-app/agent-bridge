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

/** An open Modal, and the Modal it sits in. */
type ModalRef = { host: Fiber; up: ModalRef | null }

/** A ScrollView, FlatList, FlashList (or a scrolling DOM element) and its host. */
export type Scrollable = {
  host: Fiber
  /** Every fiber over this host with scroll methods, outermost first. */
  fibers: Fiber[]
  hidden: boolean
  /** The scrollable this one sits in, for when it can't move a target into view. */
  parent: Scrollable | null
  modal: ModalRef | null
  overlay: boolean
  /** Tab bars on screen (shared): the area behind one is not visible. */
  bars: Fiber[]
}

export type Window = { width: number; height: number }

type Props = Record<string, unknown>

type Rec = Found & {
  modal: ModalRef | null
  overlay: boolean
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

// The last style that sets `display` wins, as in a flattened style.
const displayNone = (style: unknown) => displayOf(style) === 'none'

function displayOf(style: unknown): unknown {
  if (Array.isArray(style)) {
    for (let i = style.length - 1; i >= 0; i--) {
      const d = displayOf(style[i])
      if (d !== undefined) return d
    }
    return undefined
  }
  return style && typeof style === 'object'
    ? (style as Props).display
    : undefined
}

// What React Native and react-native-screens say about a subtree the user can't
// reach: inactive screens (`activityState` 0), `display: none` (react-navigation
// hides unfocused tabs that way), and accessibility hiding. Host props only.
const hiddenBy = (p: Props) =>
  p.activityState === 0 ||
  displayNone(p.style) ||
  p['aria-hidden'] === true ||
  p.accessibilityElementsHidden === true ||
  p.importantForAccessibility === 'no-hide-descendants'

const MODAL_HOSTS = new Set(['RCTModalHostView', 'ModalHostView'])
// Renders above modals (toasts, alerts), so it stays reachable under one.
const OVERLAY_HOST = 'RNSFullWindowOverlay'
const SCREEN_STACK = 'RNSScreenStack'
const STACK_SCREENS = new Set(['RNSScreen', 'RNSModalScreen'])

// react-native-screens presentations that leave what is beneath visible.
const SEE_THROUGH = new Set(['transparentModal', 'containedTransparentModal', 'overFullScreen'])

/** A `formSheet` whose detents leave the screen beneath undimmed (and touchable). */
const undimmedSheet = (p: Props) => {
  const at = p.sheetLargestUndimmedDetentIndex
  return (
    p.stackPresentation === 'formSheet' &&
    at !== undefined &&
    at !== null &&
    at !== 'none' &&
    at !== -1
  )
}

function presentationOf(screen: Fiber): string | null {
  const p = propsOf(screen)
  if (typeof p?.stackPresentation === 'string') return p.stackPresentation
  return screen.type === 'RNSModalScreen' ? 'modal' : null
}

const seeThrough = (screen: Fiber) => {
  const presentation = presentationOf(screen)
  return (
    (presentation !== null && SEE_THROUGH.has(presentation)) ||
    undimmedSheet(propsOf(screen) ?? {})
  )
}

/**
 * A presented native modal (`modal`, `pageSheet`, `fullScreenModal`,
 * `transparentModal`, ...) blocks touches outside it, however much of the
 * window it draws over. Only a sheet with undimmed detents lets them through.
 */
const coversWindow = (screen: Fiber) => {
  const presentation = presentationOf(screen)
  return (
    presentation !== null &&
    presentation !== 'push' &&
    !undimmedSheet(propsOf(screen) ?? {})
  )
}

/**
 * A native stack shows its last screen; the ones beneath stay mounted, and stay
 * visible only under transparent presentations. `presented` are the screens
 * on top of the first that cover everything outside them, tab bars included.
 */
function stackScreens(stack: Fiber): { covered: Fiber[]; presented: Fiber[] } {
  const screens: Fiber[] = []
  const todo = stack.child ? [stack.child] : []
  while (todo.length) {
    const f = todo.pop() as Fiber
    if (f.sibling) todo.push(f.sibling)
    if (f.tag === HOST_COMPONENT && STACK_SCREENS.has(f.type as string)) {
      if (propsOf(f)?.activityState !== 0) screens.push(f)
    } else if (f.child) todo.push(f.child)
  }
  let base = screens.length - 1
  while (base > 0 && seeThrough(screens[base] as Fiber)) base--
  return {
    covered: screens.slice(0, Math.max(0, base)),
    presented: screens.slice(1).filter(coversWindow),
  }
}

function hostAbove(host: Fiber): Fiber {
  let up = host.return
  while (up && up.tag !== HOST_COMPONENT) up = up.return
  return up ?? host
}

/** Android wraps a ScrollView with a RefreshControl in AndroidSwipeRefreshLayout. */
export const REFRESH_HOST = /refresh/i

/**
 * The ScrollView under an Android refresh layout gets the list's props (testID
 * included) as well: it is the same element as the layout around it.
 */
const refreshTwin = (rec: Rec | null, host: Fiber): Rec | null =>
  rec && REFRESH_HOST.test(String(rec.host.type)) && hostAbove(host) === rec.host ? rec : null

const inside = (modal: ModalRef | null, top: ModalRef) => {
  for (let m = modal; m; m = m.up) if (m === top) return true
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
    // Objects are a wrapper's context value (VirtualizedList's), not something shown.
    const v = p.value ?? p.defaultValue
    if (v != null && typeof v !== 'object' && !isFn(v)) e.value = String(v)
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

const intersect = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

const usable = (r: Rect | null): r is Rect => !!r && r.width > 0 && r.height > 0

const within = (host: Fiber, ancestor: Fiber) => {
  for (let f: Fiber | null = host; f; f = f.return) if (f === ancestor) return true
  return false
}

/**
 * What is left of `base` after the tab bars, for the ones that can be measured
 * (a native screen's own frame is no help: its origin leaves out the header).
 * Null when nothing is left. All rects are absolute: top is the largest y of
 * the clips, bottom the smallest y + height.
 */
export function visibleArea(
  base: Rect,
  host: Fiber,
  bars: Fiber[],
  window: Window,
): Rect | null {
  let area: Rect | null = base
  const clip = (r: Rect) => {
    area = area && intersect(area, r)
  }
  for (const bar of bars) {
    if (within(host, bar)) continue
    const r = measureHost(bar)
    if (!usable(r) || r.width < window.width * 0.9) continue
    // A bottom bar hides what is behind it, a top bar the same at the top.
    clip(
      r.y + r.height / 2 > window.height / 2
        ? { x: -1e9, y: -1e9, width: 2e9, height: 1e9 + r.y }
        : { x: -1e9, y: r.y + r.height, width: 2e9, height: 1e9 },
    )
  }
  return area
}

/** The visible viewport of a scrollable: its frame less the tab bar. A modal is its own window. */
export const viewportOf = (s: Scrollable, view: Rect | null, window: Window): Rect | null =>
  usable(view) ? visibleArea(view, s.host, s.modal ? [] : s.bars, window) : null

/**
 * Whether an element is on screen for touching and scrolling: inside the
 * window, with the middle of its visible part inside the content area of its
 * screen and the viewports of the scrollables around it.
 */
function isOnScreen(rec: Rec, rect: Rect | null, window: Window, bars: Fiber[]): boolean {
  if (!usable(rect)) return false
  const shown = intersect(rect, { x: 0, y: 0, ...window })
  if (!shown) return false
  const cx = shown.x + shown.width / 2
  const cy = shown.y + shown.height / 2
  const holds = (r: Rect | null) =>
    !!r && cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height
  if (!holds(visibleArea(shown, rec.host, rec.modal ? [] : bars, window))) return false
  for (let s = rec.scroller; s; s = s.parent) {
    // A scroller outside the element's modal does not clip it: a modal is its own window.
    if (s.host === rec.host || s.modal !== rec.modal) continue
    const view = measureHost(s.host)
    if (usable(view) && !holds(viewportOf(s, view, window))) return false
  }
  return true
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
  const presented = new Set<Fiber>()
  const bars: Fiber[] = []
  let topModal: ModalRef | null = null

  const recFor = (
    fiber: Fiber,
    host: Fiber,
    parent: Rec | null,
    hidden: boolean,
    scroller: Scrollable | null,
    modal: ModalRef | null,
    overlay: boolean,
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
      modal,
      overlay,
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
    modal: ModalRef | null
    overlay: boolean
  }
  const stack: Item[] = roots.map((fiber) => ({
    fiber,
    rec: null,
    hidden: false,
    scroller: null,
    modal: null,
    overlay: false,
  }))
  while (stack.length) {
    const item = stack.pop() as Item
    const { fiber, rec: parentRec } = item
    if (fiber.sibling) stack.push({ ...item, fiber: fiber.sibling })
    const p = propsOf(fiber)
    let { hidden, scroller, modal, overlay } = item
    if (fiber.tag === HOST_COMPONENT) {
      if (p && hiddenBy(p)) hidden = true
      if (covered.has(fiber)) hidden = true
      if (fiber.type === SCREEN_STACK) {
        const screens = stackScreens(fiber)
        for (const s of screens.covered) covered.add(s)
        for (const s of screens.presented) presented.add(s)
      }
      if (fiber.type === OVERLAY_HOST) overlay = true
      if (p && !hidden && (p.accessibilityRole ?? p.role) === 'tablist') bars.push(fiber)
      // A presented native modal covers the window like an RN Modal, tab bar
      // of the navigator around it included.
      if (
        !hidden &&
        (MODAL_HOSTS.has(fiber.type as string) || presented.has(fiber))
      ) {
        modal = { host: fiber, up: modal }
        topModal = modal
      }
    }
    if (scrolls(fiber)) {
      const host = firstHost(fiber)
      if (host) {
        let found = scrollByHost.get(host)
        if (!found) {
          found = { host, fibers: [], hidden, parent: scroller, modal, overlay, bars }
          scrollByHost.set(host, found)
        }
        found.fibers.push(fiber)
        scroller = found
      }
    }

    let rec = parentRec
    if (p && interesting(p)) {
      const host = firstHost(fiber)
      const twin = host && !byHost.has(host) ? refreshTwin(parentRec, host) : null
      const same = host && !twin && !byHost.has(host) ? sameControl(parentRec, p) : null
      if (host && twin) {
        byHost.set(host, twin)
        rec = twin
      } else if (host && same) {
        byHost.set(host, same)
        same.host = host
        absorbChain(same, fiber, host)
        rec = same
      } else if (host) {
        rec = recFor(fiber, host, parentRec, hidden, scroller, modal, overlay)
        absorb(rec, fiber, p)
      }
    }
    const found = textOf(fiber)
    if (found?.host) {
      const host = textHost(found.host)
      const owner = buttonOf(rec) ?? recFor(host, host, rec, hidden, scroller, modal, overlay)
      const last = owner.parts[owner.parts.length - 1]
      if (last?.host === host) last.text += found.text
      else owner.parts.push({ host, text: found.text })
    }
    if (fiber.child) stack.push({ fiber: fiber.child, rec, hidden, scroller, modal, overlay })
  }

  // Under an open modal, only the top-most modal's content can be touched.
  const top = topModal as ModalRef | null
  const covers = (x: { modal: ModalRef | null; overlay: boolean }) =>
    !!top && !x.overlay && !inside(x.modal, top)
  for (const scrollable of scrollByHost.values())
    scrollable.hidden ||= covers(scrollable)

  for (const rec of order) {
    const e = rec.element
    rec.hidden ||= covers(rec)
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
    // A ScrollView's own testID lands on its host, and the content container is
    // part of it: both scroll that scrollable, not the one around it.
    const own = scrollByHost.get(rec.host) ?? scrollByHost.get(hostAbove(rec.host))
    if (own) rec.scroller = own
    rec.onScreen = isOnScreen(rec, rect, window, bars)
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
