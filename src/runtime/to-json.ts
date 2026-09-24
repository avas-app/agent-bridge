/** Makes a tool's return value safe to send: drops functions, breaks cycles. */
export function toJson(value: unknown): unknown {
  if (value === undefined) return null
  const seen = new WeakSet<object>()
  const text = JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return v.toString()
    if (typeof v === 'function' || typeof v === 'symbol') return undefined
    if (v instanceof Error) return { name: v.name, message: v.message }
    if (v instanceof Map) return Object.fromEntries(v)
    if (v instanceof Set) return [...v]
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]'
      seen.add(v)
    }
    return v
  })
  return text === undefined ? null : JSON.parse(text)
}
