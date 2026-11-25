import type { Fiber, Rect } from '../runtime/find-text-core'
import { measureHost } from '../runtime/find-text-core'
import { firstHost } from '../runtime/screen/elements'
import { get, ownersOf, subscribe } from './registry'

export const DEFAULT_OUTLINE = '#3D7BFF'
const SHOW_AGAIN_MS = 350

export type DialRects = { rects: Rect[]; scale: number; window: { width: number; height: number } }

const MAX_RECTS = 20
const REFRESH_MS = 500
const IDLE_MS = 30_000

type Native = {
  PixelRatio?: { get(): number }
  Dimensions?: { get(d: 'window'): { width: number; height: number } }
}
const native = (): Native => {
  try {
    // Lazy, so this file loads without React Native (tests, web).
    // oxlint-disable-next-line no-require-imports
    return require('react-native') as Native
  } catch {
    return {}
  }
}

// A fiber and its alternate are the same component; either one may be the committed one.
const measureOwner = (owner: object): Rect | null => {
  const fiber = owner as Fiber & { alternate?: Fiber | null }
  for (const f of [fiber, fiber.alternate]) {
    const host = f && firstHost(f)
    if (!host) continue
    try {
      const rect = measureHost(host)
      if (rect && rect.width > 0 && rect.height > 0) return rect
    } catch {}
  }
  return null
}

/** Window-point rects of the first host view of each mounted component reading the dial. */
export function rects(id: string): DialRects {
  get(id)
  const out: Rect[] = []
  for (const owner of ownersOf(id)) {
    if (out.length >= MAX_RECTS) break
    const rect = measureOwner(owner)
    if (rect) out.push(rect)
  }
  const rn = native()
  let window = { width: 0, height: 0 }
  try {
    const w = rn.Dimensions?.get('window')
    if (w) window = { width: w.width, height: w.height }
  } catch {}
  let scale = 1
  try {
    scale = rn.PixelRatio?.get() ?? 1
  } catch {}
  return { rects: out, scale, window }
}

let active: string | null = null
let current: Rect[] = []
let timer: ReturnType<typeof setInterval> | undefined
let unsub: (() => void) | undefined
let lastCall = 0
let appColor: string | undefined
let sessionColor: string | undefined
let hidden = false
let showTimer: ReturnType<typeof setTimeout> | undefined
export type OutlineView = { rects: Rect[]; color: string; hidden: boolean }
let view: OutlineView = { rects: [], color: DEFAULT_OUTLINE, hidden: false }
const watchers = new Set<() => void>()

/** The colour from `useDials({ outline })`; a dial's own colour and the panel's `--outline` win over it. */
export const setOutlineColor = (color: string | undefined) => {
  appColor = color
}
const resolveColor = () => {
  const own = active === null ? undefined : get(active).outline?.color
  return own || sessionColor || appColor || DEFAULT_OUTLINE
}
const notify = () => {
  const color = resolveColor()
  if (view.rects === current && view.color === color && view.hidden === hidden) return
  view = { rects: current, color, hidden }
  for (const w of [...watchers]) w()
}
const stop = () => {
  if (showTimer) clearTimeout(showTimer)
  showTimer = undefined
  hidden = false
  if (timer) clearInterval(timer)
  timer = undefined
  unsub?.()
  unsub = undefined
}
const same = (a: Rect[], b: Rect[]) =>
  a.length === b.length && a.every((r, i) => r.x === b[i]!.x && r.y === b[i]!.y && r.width === b[i]!.width && r.height === b[i]!.height)
const publish = (next: Rect[]) => {
  if (same(current, next)) return
  current = next
  notify()
}
const refresh = () => {
  if (active === null) return
  if (Date.now() - lastCall > IDLE_MS) {
    active = null
    stop()
    publish([])
    return
  }
  try {
    publish(rects(active).rects)
  } catch {
    publish([])
  }
  // A Fast Refresh can change the dial's colour without moving anything.
  notify()
}

/** Outline the components reading `id`; null clears. Follows layout until 30 s pass with no call. */
export function highlight(id: string | null, options?: { color?: string }): { rects: Rect[] } {
  if (id !== null) get(id)
  stop()
  lastCall = Date.now()
  sessionColor = id === null ? undefined : options?.color || undefined
  if (id === null) {
    active = null
    publish([])
    notify()
    return { rects: [] }
  }
  active = id
  // A value change re-renders the readers; measure after they commit.
  // The outline hides while the value changes and comes back 350 ms after the last change.
  unsub = subscribe(id)(() => {
    hidden = true
    notify()
    if (showTimer) clearTimeout(showTimer)
    showTimer = setTimeout(() => {
      showTimer = undefined
      hidden = false
      refresh()
      notify()
    }, SHOW_AGAIN_MS)
    setTimeout(refresh, 0)
  })
  timer = setInterval(refresh, REFRESH_MS)
  refresh()
  notify()
  return { rects: current }
}

export const highlighted = () => current
export const outlineView = () => view
export const watchHighlight = (cb: () => void) => {
  watchers.add(cb)
  return () => void watchers.delete(cb)
}

/** For tests. */
export function resetHighlight() {
  stop()
  active = null
  current = []
  appColor = undefined
  sessionColor = undefined
  view = { rects: [], color: DEFAULT_OUTLINE, hidden: false }
  watchers.clear()
}
