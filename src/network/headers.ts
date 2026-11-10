/** Headers whose values are credentials: net.entry cuts them unless asked for the whole. */
const SECRET = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/

const lower = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))

/** A copy with lower-cased names; undefined when there are none, so entries stay lean. */
export function keepHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return headers && Object.keys(headers).length ? lower(headers) : undefined
}

/** Credential values cut to a short prefix, like truncateBody does for bodies. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!SECRET.test(name)) {
      out[name] = value
      continue
    }
    const keep = Math.min(8, Math.floor(value.length / 2))
    out[name] = `${value.slice(0, keep)}… (+${value.length - keep} chars)`
  }
  return out
}

/** XMLHttpRequest's getAllResponseHeaders() text as a record; repeated names join with ", ". */
export function parseHeaderBlock(block: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (block ?? '').split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const name = line.slice(0, at).trim().toLowerCase()
    const value = line.slice(at + 1).trim()
    out[name] = name in out ? `${out[name]}, ${value}` : value
  }
  return out
}
