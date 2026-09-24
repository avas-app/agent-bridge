import { bodyText, errorMessage, formatBody, isTextual } from './body'
import {
  type Answer,
  answer,
  finishEntry,
  isOffline,
  isSkipped,
  matchingMocks,
  mockRequest,
  type NetworkState,
  OFFLINE_MESSAGE,
  responseParts,
  sleep,
  startEntry,
} from './state'

type FetchFn = (input: unknown, init?: RequestInit) => Promise<Response>
type RequestLike = {
  url?: string
  method?: string
  headers?: unknown
  clone?: () => { text: () => Promise<string> }
}

export function headersRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  const h = headers as {
    forEach?: (fn: (value: string, key: string) => void) => void
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value)
  } else if (typeof h.forEach === 'function') {
    h.forEach((value, key) => {
      out[key.toLowerCase()] = value
    })
  } else {
    for (const [key, value] of Object.entries(headers))
      out[key.toLowerCase()] = String(value)
  }
  return out
}

// 204, 205 and 304 can't carry a body; Response throws if given one.
const nullBody = (status: number) => [101, 204, 205, 304].includes(status)

function mockedResponse(response: Answer['response']): Response {
  const { status, text, headers } = responseParts(response)
  const body = nullBody(status) ? null : text
  if (typeof Response !== 'undefined')
    return new Response(body, { status, headers })
  // No Response class: enough of one for `await res.json()` style code.
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    url: '',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
    clone() {
      return mockedResponse(response)
    },
  } as unknown as Response
}

function abortError(): Error {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

/** Wraps global fetch to log requests and answer them from mocks. */
export function patchFetch(state: NetworkState): (() => void) | null {
  const g = globalThis as unknown as { fetch?: FetchFn }
  const original = g.fetch
  if (typeof original !== 'function') return null

  // On React Native the original fetch opens an XHR synchronously; the XHR
  // patch sees `insideFetch` and leaves it alone, so nothing is logged twice.
  const callOriginal = (input: unknown, init?: RequestInit) => {
    state.insideFetch += 1
    try {
      return original.call(globalThis, input, init)
    } finally {
      state.insideFetch -= 1
    }
  }

  const wrapped = function fetch(input: unknown, init?: RequestInit) {
    const req = (typeof input === 'object' && input ? input : {}) as RequestLike
    const url =
      typeof input === 'string' ? input : (req.url ?? String(input))
    if (isSkipped(state, url)) return callOriginal(input, init)

    const method = String(init?.method ?? req.method ?? 'GET').toUpperCase()
    const requestBody = bodyText(init?.body)
    const entry = startEntry(state, {
      method,
      url,
      requestBody: formatBody(requestBody),
    })

    const real = () => {
      let promise: Promise<Response>
      try {
        promise = callOriginal(input, init)
      } catch (error) {
        finishEntry(entry, { error: errorMessage(error) })
        throw error
      }
      return promise.then(
        (res) => {
          finishEntry(entry, { status: res.status })
          const type = res.headers?.get?.('content-type')
          if (isTextual(type) && typeof res.clone === 'function') {
            res
              .clone()
              .text()
              .then((text) => {
                const body = formatBody(text)
                if (body !== undefined) entry.responseBody = body
              })
              .catch(() => {})
          }
          return res
        },
        (error: unknown) => {
          finishEntry(entry, { error: errorMessage(error) })
          throw error
        },
      )
    }

    const candidates = matchingMocks(state, method, url)
    if (!candidates.length) return real()

    const request = async () => {
      let body = requestBody
      if (body === undefined && init?.body === undefined && req.clone) {
        body = await req
          .clone()
          .text()
          .catch(() => undefined)
      }
      return mockRequest(
        method,
        url,
        headersRecord(init?.headers ?? req.headers),
        body || undefined,
      )
    }

    const answered = answer(state, candidates, request).catch((error) => {
      // A handler threw: the app sees the error, the log says why.
      entry.mocked = true
      finishEntry(entry, { error: errorMessage(error) })
      throw error
    })
    return answered.then(async (hit) => {
      if (!hit) return real()
      entry.mocked = true
      await sleep(hit.mock.delayMs)
      if (init?.signal?.aborted) {
        finishEntry(entry, { error: 'aborted' })
        throw abortError()
      }
      if (isOffline(hit.response)) {
        finishEntry(entry, { error: `${OFFLINE_MESSAGE} (mocked offline)` })
        throw new TypeError(OFFLINE_MESSAGE)
      }
      const { status, text } = responseParts(hit.response)
      finishEntry(entry, { status, responseBody: formatBody(text) })
      return mockedResponse(hit.response)
    })
  }

  g.fetch = wrapped as FetchFn
  return () => {
    if (g.fetch === wrapped) g.fetch = original
  }
}
