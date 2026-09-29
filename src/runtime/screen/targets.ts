import type { Found, ScreenElement } from './elements'

/**
 * What to act on. A string tries testID, then label, then placeholder, then
 * visible text (exact, then substring). An object must match every field it
 * sets; `index` picks one of several matches; `at: [x, y]` picks the smallest
 * element covering that point (for controls with no text, label or testID).
 */
export type Target =
  | string
  | {
      testID?: string
      label?: string
      placeholder?: string
      text?: string
      at?: [number, number]
      index?: number
    }

const TARGET_KEYS = ['testID', 'label', 'placeholder', 'text', 'at', 'index']

/** Rejects what would otherwise match everything, like a typo'd key. */
function checkTarget(target: Target): void {
  if (typeof target === 'string') return
  if (target === null || typeof target !== 'object' || Array.isArray(target))
    throw new Error(
      `A target is a string or an object with ${TARGET_KEYS.join(', ')}; got ${JSON.stringify(target)}`,
    )
  const unknown = Object.keys(target).filter((k) => !TARGET_KEYS.includes(k))
  if (unknown.length)
    throw new Error(
      `Unknown target key ${unknown.map((k) => JSON.stringify(k)).join(', ')}. Valid keys: ${TARGET_KEYS.join(', ')}`,
    )
  const { at, index } = target
  if (
    at !== undefined &&
    !(Array.isArray(at) && at.length === 2 && at.every(Number.isFinite))
  )
    throw new Error(`Target "at" must be [x, y] in window points; got ${JSON.stringify(at)}`)
  if (index !== undefined && !Number.isInteger(index))
    throw new Error(`Target "index" must be an integer; got ${JSON.stringify(index)}`)
}

type Test = (e: ScreenElement) => boolean

const covers = (e: ScreenElement, [x, y]: [number, number]) =>
  !!e.rect &&
  x >= e.rect.x &&
  x <= e.rect.x + e.rect.width &&
  y >= e.rect.y &&
  y <= e.rect.y + e.rect.height

const area = (f: Found) => (f.element.rect ? f.element.rect.width * f.element.rect.height : 0)

function tiers(target: Target): Test[] {
  if (typeof target === 'string') {
    return [
      (e) => e.testID === target,
      (e) => e.label === target,
      (e) => e.placeholder === target,
      (e) => e.text === target,
      (e) => !!e.text?.includes(target),
    ]
  }
  const { testID, label, placeholder, text, at } = target
  const fields: Test = (e) =>
    (testID === undefined || e.testID === testID) &&
    (at === undefined || covers(e, at)) &&
    (label === undefined || e.label === label) &&
    (placeholder === undefined || e.placeholder === placeholder)
  if (text === undefined) return [fields]
  return [
    (e) => fields(e) && e.text === text,
    (e) => fields(e) && !!e.text?.includes(text),
  ]
}

/** Matches from the first tier that has any. */
export function matchTarget(found: Found[], target: Target): Found[] {
  checkTarget(target)
  for (const test of tiers(target)) {
    const matches = found.filter((f) => test(f.element))
    // Innermost first, so a point on an icon means the icon, not its screen.
    if (matches.length)
      return isAt(target) ? matches.sort((a, b) => area(a) - area(b)) : matches
  }
  return []
}

const isAt = (target: Target) => typeof target === 'object' && target.at !== undefined

export const indexOf = (target: Target) =>
  typeof target === 'object' ? target.index : undefined

const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s)

/** One line an agent can read, e.g. `button #save-plant "Save plant"`. */
export function describe(e: ScreenElement): string {
  const bits: string[] = [e.kind]
  if (e.testID) bits.push(`#${e.testID}`)
  if (e.text) bits.push(JSON.stringify(clip(e.text)))
  if (e.label && e.label !== e.text) bits.push(`label=${JSON.stringify(clip(e.label))}`)
  if (e.placeholder) bits.push(`placeholder=${JSON.stringify(clip(e.placeholder))}`)
  if (e.value !== undefined) bits.push(`value=${JSON.stringify(clip(e.value))}`)
  if (e.disabled) bits.push('disabled')
  return bits.join(' ')
}

export const showTarget = (target: Target) => JSON.stringify(target)

/** A short list of what is on screen, for error messages. */
export function onScreenSummary(found: Found[], max = 15): string {
  const on = found.filter((f) => f.onScreen)
  if (!on.length) return 'nothing'
  const shown = on.slice(0, max).map((f) => describe(f.element))
  if (on.length > max) shown.push(`+${on.length - max} more`)
  return shown.join('; ')
}

/**
 * The one on-screen element a target means. When several match, those that
 * can do what the caller wants (`press`, `fill`) win; still several is an error.
 * `options.index` is the trailing `{ index }` argument; it beats the target's own.
 * `options.afterText` says the caller takes a text argument before its options (fill).
 */
export function resolveTarget(
  found: Found[],
  target: Target,
  prefer?: (f: Found) => boolean,
  options?: { index?: number; afterText?: boolean },
): Found {
  let matches = matchTarget(
    found.filter((f) => f.onScreen),
    target,
  )
  if (!matches.length) {
    const hidden = matchTarget(found, target)[0]
    if (hidden)
      throw new Error(
        `${showTarget(target)} matches ${describe(hidden.element)}, which is not on screen`,
      )
    throw new Error(
      `Nothing on screen matches ${showTarget(target)}. On screen: ${onScreenSummary(found)}`,
    )
  }
  const preferred = prefer ? matches.filter(prefer) : []
  if (preferred.length) matches = preferred
  const index = options?.index ?? indexOf(target) ?? (isAt(target) ? 0 : undefined)
  if (index !== undefined) {
    const pick = matches[index]
    if (!pick)
      throw new Error(
        `${showTarget(target)} has ${matches.length} match(es); index ${index} is out of range`,
      )
    return pick
  }
  if (matches.length > 1) {
    const list = matches
      .slice(0, 10)
      .map((f, i) => `${i}: ${describe(f.element)}`)
      .join('; ')
    const example =
      typeof target === 'string'
        ? `${JSON.stringify(options?.afterText ? [target, '<text>', { index: 1 }] : [target, { index: 1 }])} (index as the last argument)`
        : `${JSON.stringify({ ...target, index: 1 })} (index inside the target)`
    throw new Error(
      `${showTarget(target)} matches ${matches.length} elements; pick one with an index, e.g. ${example}, or use a narrower target. ${list}`,
    )
  }
  return matches[0] as Found
}
