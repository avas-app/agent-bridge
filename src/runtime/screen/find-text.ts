import type { Rect } from '../find-text-core'
import type { Found } from './elements'
import { describe } from './targets'

export type FindTextOptions = {
  exact?: boolean
  /** Also search accessibility labels (default true). */
  labels?: boolean
}

export type TextMatch = {
  text: string
  /** Which field matched: the rendered text, or the accessibility label. */
  field: 'text' | 'label'
  rect: Rect | null
  onScreen: boolean
}

export type FindTextResult = {
  found: number
  onScreen: number
  matches: TextMatch[]
  /** Only when nothing matched: similar elements, so the agent sees why. */
  nearMisses?: string[]
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Elements whose text or label almost matches: the same words in another case
 * or spacing, or a fragment of the string (text split across elements).
 */
export function nearMisses(found: Found[], text: string, max = 5): string[] {
  const want = normalize(text)
  if (!want) return []
  const close = (s: string | undefined) => {
    const have = s && normalize(s)
    return !!have && (have.includes(want) || (have.length >= 3 && want.includes(have)))
  }
  return found
    .filter((f) => close(f.element.text) || close(f.element.label))
    .slice(0, max)
    .map((f) => `${describe(f.element)}${f.onScreen ? '' : ' (off screen)'}`)
}

/**
 * Matches the same joined text `screen.snapshot` shows (and, unless
 * `labels:false`, accessibility labels), on screen or not.
 */
export function findText(
  found: Found[],
  text: string,
  options: FindTextOptions = {},
): FindTextResult {
  const test = (s: string | undefined) =>
    s !== undefined && (options.exact ? s === text : s.includes(text))
  const matches: TextMatch[] = []
  for (const f of found) {
    const { element } = f
    const field = test(element.text)
      ? 'text'
      : options.labels !== false && test(element.label)
        ? 'label'
        : null
    if (!field) continue
    matches.push({
      text: (field === 'text' ? element.text : element.label) as string,
      field,
      rect: element.rect,
      onScreen: f.onScreen,
    })
  }
  const result: FindTextResult = {
    found: matches.length,
    onScreen: matches.filter((m) => m.onScreen).length,
    matches,
  }
  if (!matches.length) result.nearMisses = nearMisses(found, text)
  return result
}
