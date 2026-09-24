const MAX_BODY = 2048

/** Body text for the log: JSON re-serialised compactly, cut at ~2 KB. */
export function formatBody(text: string | undefined): string | undefined {
  if (text === undefined || text === '') return undefined
  let out = text
  try {
    out = JSON.stringify(JSON.parse(text))
  } catch {
    // not JSON; keep the text as it is
  }
  return out.length > MAX_BODY
    ? `${out.slice(0, MAX_BODY)}… (+${out.length - MAX_BODY} chars)`
    : out
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
