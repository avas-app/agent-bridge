import { SECRET } from '../network/headers'

const MAX_STRING = 2000
const MAX_ITEMS = 50
const MAX_DEPTH = 5

const isPlain = (v: object) => {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * A copy of an outgoing payload for the log: later changes by the app don't
 * rewrite history, long strings are cut and binary data is named, not kept.
 */
export function snapshot(value: unknown, depth = 0): unknown {
  if (typeof value === 'string')
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (+${value.length - MAX_STRING} chars)` : value
  if (typeof value === 'function') return '[function]'
  if (!value || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    return `[${value.constructor.name} ${value.byteLength} bytes]`
  if (depth >= MAX_DEPTH) return '[…]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => snapshot(v, depth + 1))
    if (value.length > MAX_ITEMS) items.push(`… (+${value.length - MAX_ITEMS} items)`)
    return items
  }
  if (value instanceof Date) return value.toISOString()
  if (!isPlain(value)) return `[${value.constructor?.name ?? 'object'}]`
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).slice(0, MAX_ITEMS))
    out[key] = snapshot((value as Record<string, unknown>)[key], depth + 1)
  return out
}

/** The same value with credential-looking keys (token, password, …) blanked. */
export function redact(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== 'object' || depth >= MAX_DEPTH + 1) return value
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value))
    out[key] = SECRET.test(key) ? '[redacted]' : redact(v, depth + 1)
  return out
}
