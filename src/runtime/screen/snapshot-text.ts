import type { Rect } from '../find-text-core'
import type { ElementKind, ScreenElement } from './elements'
import { describe } from './targets'

export const ELEMENT_KINDS: ElementKind[] = ['button', 'input', 'text', 'view', 'webview']

const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

/** Whether the middle of `e` is inside `box`. */
export function insideRect(e: ScreenElement, box: Rect): boolean {
  if (!e.rect) return false
  const c = center(e.rect)
  return c.x >= box.x && c.x <= box.x + box.width && c.y >= box.y && c.y <= box.y + box.height
}

/**
 * One line per element, as `describe` writes it, plus what an agent needs to act:
 * `actions`, off-screen / hidden marks, and the middle of the element (`@x,y`, the
 * point `{at:[x,y]}` takes) only on lines that would otherwise read the same.
 */
export function snapshotText(elements: ScreenElement[], hidden?: number): string {
  const lines = elements.map((e) => {
    const bits = [describe(e, 80)]
    if (e.editable === false) bits.push('readonly')
    if (e.actions?.length) bits.push(`actions=${e.actions.join(',')}`)
    if (e.onScreen === false) bits.push('offscreen')
    if (e.hidden) bits.push('hidden')
    return bits.join(' ')
  })
  const seen = new Map<string, number>()
  for (const l of lines) seen.set(l, (seen.get(l) ?? 0) + 1)
  const out = lines.map((l, i) => {
    const rect = elements[i]?.rect
    if ((seen.get(l) ?? 0) < 2 || !rect) return l
    const c = center(rect)
    return `${l} @${Math.round(c.x)},${Math.round(c.y)}`
  })
  if (hidden) out.push(`(${hidden} hidden: on screens not in front; {all:true} lists them)`)
  return out.length ? out.join('\n') : '(nothing on screen)'
}
