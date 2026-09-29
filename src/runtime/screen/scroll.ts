// Scrolls a ScrollView, FlatList or FlashList through its own methods, and
// fires a RefreshControl's onRefresh, the way the gestures would.
import { type Fiber, type Rect, measureHost } from '../find-text-core'
import { type Found, type Scrollable, type Window, propsOf } from './elements'
import { describe, type Target } from './targets'

type Fn = (...args: unknown[]) => unknown
type Node = Record<string, unknown>

/** What `screen.scroll` does: to a target, to either end, or by a distance. */
export type ScrollCommand =
  | { kind: 'to'; target: Target }
  | { kind: 'toEnd' }
  | { kind: 'toStart' }
  | { kind: 'by'; amount: number }

const COMMANDS = ['to', 'toEnd', 'toStart', 'by']

/** `{to}`, `{toEnd:true}`, `{toStart:true}` and `{by}` are commands; anything else is a target. */
export function parseScroll(arg: Target | Record<string, unknown>): ScrollCommand {
  if (
    arg === null ||
    typeof arg !== 'object' ||
    Array.isArray(arg) ||
    !COMMANDS.some((k) => k in arg)
  )
    return { kind: 'to', target: arg as Target }
  const keys = Object.keys(arg)
  if (keys.length !== 1)
    throw new Error(
      `screen.scroll takes one of {to: target}, {toEnd:true}, {toStart:true} or {by: points}; got ${JSON.stringify(arg)}`,
    )
  const [key] = keys as [string]
  const value = (arg as Record<string, unknown>)[key]
  if (key === 'to') return { kind: 'to', target: value as Target }
  if (key === 'by') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(`{by} is a number of points (negative scrolls back); got ${JSON.stringify(value)}`)
    return { kind: 'by', amount: value }
  }
  if (value !== true) throw new Error(`{${key}} must be true; got ${JSON.stringify(value)}`)
  return { kind: key as 'toEnd' | 'toStart' }
}

const nodeOf = (fiber: Fiber): Node | null => {
  const n = fiber.stateNode
  return n && typeof n === 'object' ? (n as Node) : null
}

const method = (fiber: Fiber, name: string): Fn | null => {
  const node = nodeOf(fiber)
  const fn = node?.[name]
  return typeof fn === 'function' ? (fn as Fn).bind(node) : null
}

export const isHorizontal = (s: Scrollable) =>
  s.fibers.some((f) => propsOf(f)?.horizontal === true)

// The scroll content view: the first host under the scroll host that isn't a
// refresh control. Its offset from the viewport is how far we have scrolled.
function contentHost(s: Scrollable): Fiber | null {
  const todo = s.host.child ? [s.host.child] : []
  while (todo.length) {
    const f = todo.pop() as Fiber
    if (f.sibling) todo.push(f.sibling)
    if (f.tag === 5) {
      if (!/refresh/i.test(String(f.type))) return f
    } else if (f.child) todo.push(f.child)
  }
  return null
}

export type Metrics = {
  /** Points scrolled along the scroll axis. */
  offset: number
  /** The furthest offset, when the content size is known. */
  max: number | null
  view: Rect | null
}

/** Where the scrollable is scrolled to, along its own axis. */
export function metricsOf(s: Scrollable): Metrics | null {
  const horizontal = isHorizontal(s)
  const node = nodeOf(s.host)
  const view = measureHost(s.host)
  if (node && typeof node.scrollTop === 'number' && typeof node.scrollHeight === 'number') {
    const size = horizontal
      ? [node.scrollLeft, node.scrollWidth, node.clientWidth]
      : [node.scrollTop, node.scrollHeight, node.clientHeight]
    const [offset, total, shown] = size as number[]
    return { offset: offset as number, max: Math.max(0, (total as number) - (shown as number)), view }
  }
  const content = contentHost(s)
  const box = content && measureHost(content)
  if (!view || !box) return null
  return horizontal
    ? { offset: view.x - box.x, max: Math.max(0, box.width - view.width), view }
    : { offset: view.y - box.y, max: Math.max(0, box.height - view.height), view }
}

const round = (n: number) => Math.round(n * 100) / 100

/** Scrolls to `offset` along the scroll axis, without animation. */
export function scrollToOffset(s: Scrollable, offset: number): void {
  const horizontal = isHorizontal(s)
  const x = horizontal ? offset : 0
  const y = horizontal ? 0 : offset
  // ScrollView reads {x, y}; DOM elements read {left, top}.
  const target = { x, y, left: x, top: y, animated: false, behavior: 'instant' }
  for (const f of [...s.fibers].reverse()) {
    const scrollTo = method(f, 'scrollTo')
    if (scrollTo) return void scrollTo(target)
  }
  for (const f of s.fibers) {
    const toOffset = method(f, 'scrollToOffset')
    if (toOffset) return void toOffset({ offset, animated: false })
  }
  throw new Error('This scrollable has no scrollTo or scrollToOffset')
}

/** To the end: a list's own scrollToEnd (it knows about unrendered rows), else the last offset. */
export function scrollToEnd(s: Scrollable): void {
  for (const f of s.fibers) {
    const toEnd = method(f, 'scrollToEnd')
    if (toEnd) return void toEnd({ animated: false })
  }
  const max = metricsOf(s)?.max
  if (max == null) throw new Error('This scrollable has no scrollToEnd and its size is unknown')
  scrollToOffset(s, max)
}

/** Scrolls so the element sits in the middle of the viewport (or starts at its top, if taller). */
export function scrollIntoView(s: Scrollable, found: Found): void {
  const rect = found.element.rect
  const m = metricsOf(s)
  if (!rect || !m?.view) throw new Error(`${describe(found.element)} has no position to scroll to`)
  const horizontal = isHorizontal(s)
  const [start, size, viewStart, viewSize] = horizontal
    ? [rect.x, rect.width, m.view.x, m.view.width]
    : [rect.y, rect.height, m.view.y, m.view.height]
  if (start >= viewStart && start + size <= viewStart + viewSize) return
  const delta =
    size >= viewSize
      ? start - viewStart
      : start + size / 2 - (viewStart + viewSize / 2)
  const next = Math.max(0, Math.min(m.max ?? Infinity, m.offset + delta))
  scrollToOffset(s, round(next))
}

/** The scrollable whose `onRefresh` a pull would call. */
export function refreshHandler(s: Scrollable): Fn | null {
  for (const f of s.fibers) {
    const p = propsOf(f)
    const control = (p?.refreshControl as { props?: Node } | undefined)?.props
    if (typeof control?.onRefresh === 'function') return control.onRefresh as Fn
    if (typeof p?.onRefresh === 'function') return p.onRefresh as Fn
  }
  return null
}

const area = (r: Rect | null) => (r ? r.width * r.height : 0)

const onWindow = (r: Rect | null, w: Window) =>
  !!r && r.width > 0 && r.height > 0 && r.x < w.width && r.y < w.height && r.x + r.width > 0 && r.y + r.height > 0

/** With no target: the largest scrollable on screen (that can refresh, for a refresh). */
export function mainScrollable(
  scrollables: Scrollable[],
  window: Window,
  need: 'scroll' | 'refresh',
): Scrollable {
  const candidates = scrollables
    .filter((s) => !s.hidden && (need === 'scroll' || refreshHandler(s)))
    .map((s) => ({ s, rect: measureHost(s.host) }))
    .filter(({ rect }) => onWindow(rect, window))
    .sort((a, b) => area(b.rect) - area(a.rect))
  const [best] = candidates
  if (!best)
    throw new Error(
      need === 'refresh'
        ? 'No scrollable on screen has a RefreshControl (or an onRefresh prop)'
        : 'No scrollable on screen',
    )
  return best.s
}
