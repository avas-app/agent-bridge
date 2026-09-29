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

const REFRESH_HOST = /refresh/i

// Android wraps the ScrollView in AndroidSwipeRefreshLayout when it has a
// RefreshControl, so the host the scroll methods belong to is one level down.
function scrollNode(s: Scrollable): Fiber {
  if (!REFRESH_HOST.test(String(s.host.type))) return s.host
  const todo = s.host.child ? [s.host.child] : []
  while (todo.length) {
    const f = todo.pop() as Fiber
    if (f.sibling) todo.push(f.sibling)
    if (f.tag === 5) return f
    if (f.child) todo.push(f.child)
  }
  return s.host
}

// The scroll content view: the first host under the scroll host that isn't a
// refresh control. Its offset from the viewport is how far we have scrolled.
function contentHost(node: Fiber): Fiber | null {
  const todo = node.child ? [node.child] : []
  while (todo.length) {
    const f = todo.pop() as Fiber
    if (f.sibling) todo.push(f.sibling)
    if (f.tag === 5) {
      if (!REFRESH_HOST.test(String(f.type))) return f
    } else if (f.child) todo.push(f.child)
  }
  return null
}

// `inverted` lists, and lists flipped with a scale(-1) transform, draw their
// content mirrored: window positions run against the scroll offset.
function isInverted(s: Scrollable, horizontal: boolean): boolean {
  const axis = horizontal ? 'scaleX' : 'scaleY'
  return s.fibers.some((f) => {
    const p = propsOf(f)
    if (p?.inverted === true) return true
    const style = ([] as unknown[]).concat(p?.style ?? []).flat(Infinity)
    return style.some((st) => {
      const t = (st as { transform?: unknown } | null)?.transform
      return (
        Array.isArray(t) &&
        t.some(
          (x) =>
            x &&
            typeof x === 'object' &&
            ((x as Node)[axis] === -1 || (x as Node).scale === -1),
        )
      )
    })
  })
}

export type Metrics = {
  /** Points scrolled along the scroll axis. */
  offset: number
  /** The furthest offset, when the content size is known. */
  max: number | null
  view: Rect | null
  /** Window positions run against the offset. */
  inverted: boolean
}

/** Where the scrollable is scrolled to, along its own axis. */
export function metricsOf(s: Scrollable): Metrics | null {
  const horizontal = isHorizontal(s)
  const host = scrollNode(s)
  const node = nodeOf(host)
  const view = measureHost(host)
  if (node && typeof node.scrollTop === 'number' && typeof node.scrollHeight === 'number') {
    const size = horizontal
      ? [node.scrollLeft, node.scrollWidth, node.clientWidth]
      : [node.scrollTop, node.scrollHeight, node.clientHeight]
    const [offset, total, shown] = size as number[]
    return {
      offset: offset as number,
      max: Math.max(0, (total as number) - (shown as number)),
      view,
      inverted: false,
    }
  }
  const content = contentHost(host)
  const box = content && measureHost(content)
  if (!view || !box) return null
  const max = Math.max(0, horizontal ? box.width - view.width : box.height - view.height)
  const shown = horizontal ? view.x - box.x : view.y - box.y
  const inverted = isInverted(s, horizontal)
  return { offset: inverted ? max - shown : shown, max, view, inverted }
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

/** A scrollable a user can drag: not `scrollEnabled={false}`. */
export const scrollEnabled = (s: Scrollable) =>
  !s.fibers.some((f) => propsOf(f)?.scrollEnabled === false)

/**
 * The offset that puts the element in the middle of the viewport (or starts it
 * at the top, if taller); null when it is already fully in view.
 */
export function offsetFor(s: Scrollable, found: Found): number | null {
  const rect = found.element.rect
  const m = metricsOf(s)
  if (!rect || !m?.view) return null
  const [start, size, viewStart, viewSize] = isHorizontal(s)
    ? [rect.x, rect.width, m.view.x, m.view.width]
    : [rect.y, rect.height, m.view.y, m.view.height]
  if (start >= viewStart && start + size <= viewStart + viewSize) return null
  const delta =
    size >= viewSize ? start - viewStart : start + size / 2 - (viewStart + viewSize / 2)
  const next = Math.max(0, Math.min(m.max ?? Infinity, m.offset + (m.inverted ? -delta : delta)))
  return Math.abs(next - m.offset) < 1 ? null : round(next)
}

/** The scrollable, from the innermost out, that can move the element into view. */
export function scrollerFor(found: Found): { scrollable: Scrollable; offset: number } | null {
  for (let s = found.scroller; s; s = s.parent) {
    if (s.hidden || !scrollEnabled(s)) continue
    const offset = offsetFor(s, found)
    if (offset !== null) return { scrollable: s, offset }
  }
  return null
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * scrollTo runs on the UI thread and the new position comes back later, with no
 * React commit to wait for. Polls until the offset reaches `want` (when known)
 * or stops moving, for at most ~300 ms.
 */
export async function awaitScroll(
  s: Scrollable,
  before: number | undefined,
  want?: number,
): Promise<Metrics | null> {
  const near = (x: Metrics | null, to: number | undefined) =>
    !!x && to !== undefined && Math.abs(x.offset - to) < 1
  let m = metricsOf(s)
  if (!m || near(m, want)) return m
  let idle = 0
  for (let waited = 0; waited < 300; waited += 16) {
    await wait(16)
    const next = metricsOf(s)
    if (!next || near(next, want)) return next
    idle = Math.abs(next.offset - m.offset) < 1 ? idle + 1 : 0
    m = next
    // Moved away from where it was, then held still: it has landed.
    if (idle >= 2 && !near(m, before)) break
  }
  return m
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
    .filter((s) => !s.hidden && (need === 'refresh' ? refreshHandler(s) : scrollEnabled(s)))
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
