import type { Rect } from '../find-text-core'
import type { ElementKind, Found, ScreenElement } from './elements'
import { describe } from './targets'

export const ELEMENT_KINDS: ElementKind[] = ['button', 'input', 'text', 'view', 'webview']

const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

/** Whether `found` is `scope` or sits under it in the fiber tree. */
export function underScope(found: Found, scope: Found): boolean {
  for (let f: Found['fiber'] | null = found.fiber; f; f = f.return) if (f === scope.fiber) return true
  return false
}

export type TextLine = {
  element: ScreenElement
  /** The match number a `{index}` takes for the line's best target, when it can be worked out. */
  index?: number
}

/**
 * One line per element, as `describe` writes it, plus what an agent needs to act:
 * `actions`, off-screen / hidden marks, `index=N` on lines that repeat (the `index`
 * of the target that names it), and the middle of the element (`@x,y`, the point
 * `{at:[x,y]}` takes) where nothing else can name it.
 */
export function snapshotText(lines: TextLine[], hidden?: number, empty = '(nothing on screen)'): string {
  const base = lines.map(({ element: e }) => {
    const bits = [describe(e, 80, true)]
    if (e.editable === false) bits.push('readonly')
    if (e.actions?.length) bits.push(`actions=${e.actions.join(',')}`)
    if (e.onScreen === false) bits.push('offscreen')
    if (e.hidden) bits.push('hidden')
    return bits.join(' ')
  })
  const seen = new Map<string, number>()
  for (const l of base) seen.set(l, (seen.get(l) ?? 0) + 1)
  const out = base.map((l, i) => {
    const { element: e, index } = lines[i] as TextLine
    const repeats = (seen.get(l) ?? 0) > 1
    const named = !!(e.testID || e.text || e.label || e.placeholder)
    const bits = [l]
    if (repeats && index !== undefined) bits.push(`index=${index}`)
    if (e.rect && ((repeats && index === undefined) || !named)) {
      const c = center(e.rect)
      bits.push(`@${Math.round(c.x)},${Math.round(c.y)}`)
    }
    return bits.join(' ')
  })
  if (hidden) out.push(`(${hidden} hidden: on screens not in front; {all:true} lists them)`)
  return lines.length || hidden ? out.join('\n') : empty
}
