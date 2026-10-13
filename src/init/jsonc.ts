// Reads JSON with comments and trailing commas (tsconfig, .oxlintrc.json), and
// adds to one array in it by editing the text, so the rest keeps its formatting.

/** The text with comments and trailing commas blanked out, same length and offsets. */
function strip(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      const j = end === -1 ? text.length : end
      out += ' '.repeat(j - i)
      i = j
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const j = end === -1 ? text.length : end + 2
      out += text.slice(i, j).replace(/[^\n]/g, ' ')
      i = j
    } else {
      out += c
      i++
    }
  }
  return out.replace(/,(\s*[}\]])/g, ' $1')
}

/** Undefined when it isn't JSON even with comments allowed. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(strip(text))
  } catch {
    return undefined
  }
}

/**
 * Adds `value` to the top-level array `key`, creating it from `initial` when
 * missing. Undefined when the text can't be edited safely.
 */
export function addToArray(
  text: string,
  key: string,
  value: string,
  initial: string[] = [],
): string | undefined {
  const json = parseJsonc(text)
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined
  const current = (json as Record<string, unknown>)[key]
  const clean = strip(text)
  const item = JSON.stringify(value)
  if (Array.isArray(current)) {
    // Only one occurrence, so it is the top-level key.
    const matches = [...clean.matchAll(new RegExp(`"${key}"\\s*:\\s*\\[`, 'g'))]
    if (matches.length !== 1) return undefined
    const at = matches[0]!.index! + matches[0]![0].length
    const after = text.slice(at)
    const multiline = after.match(/^[ \t]*\n([ \t]*)/)
    if (!current.length) return `${text.slice(0, at)}${item}${after}`
    if (multiline) return `${text.slice(0, at)}\n${multiline[1]}${item},${after}`
    return `${text.slice(0, at)}${item}, ${after}`
  }
  if (current !== undefined) return undefined
  // Right after the last value, so a trailing comma or comment stays after ours.
  const end = clean.slice(0, clean.lastIndexOf('}')).trimEnd().length
  const indent = text.match(/^([ \t]+)"/m)?.[1] ?? '  '
  const comma = clean.slice(0, end).endsWith('{') ? '' : ','
  const list = [...initial, value].map((v) => JSON.stringify(v)).join(', ')
  return `${text.slice(0, end)}${comma}\n${indent}"${key}": [${list}]${text.slice(end)}`
}
