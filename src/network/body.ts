const MAX_BODY = 2048
/** The longest body kept whole for `net.entry`; a longer one can't become a mock. */
export const MAX_FULL_BODY = 1_000_000
/** All whole bodies together; the oldest go first, their previews stay. */
export const FULL_BUDGET = 4_000_000

/** Body text for the log: JSON re-serialised compactly. */
export function compactBody(text: string | undefined): string | undefined {
  if (text === undefined || text === '') return undefined
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return text // not JSON; keep the text as it is
  }
}

/** Cuts a compact body at ~2 KB, saying how much is left out. */
export function truncateBody(text: string): string {
  return text.length > MAX_BODY
    ? `${text.slice(0, MAX_BODY)}… (+${text.length - MAX_BODY} chars)`
    : text
}

/** A request body as text, or a short label for binary bodies. */
export function bodyText(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
    return body.toString()
  if (typeof FormData !== 'undefined' && body instanceof FormData)
    return '[FormData]'
  if (typeof Blob !== 'undefined' && body instanceof Blob)
    return `[Blob ${body.size} bytes]`
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body))
    return `[binary ${(body as ArrayBuffer).byteLength} bytes]`
  return String(body)
}

/** Worth reading a response body for the log (not images, streams, etc.). */
export function isTextual(contentType: string | null | undefined): boolean {
  if (!contentType) return true
  if (/event-stream/i.test(contentType)) return false
  return /json|text|xml|javascript|x-www-form-urlencoded/i.test(contentType)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
