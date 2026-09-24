import { bodyText, errorMessage, formatBody } from './body'
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
import type { LogEntry } from './types'

type Entry = LogEntry & { started: number }
type Meta = {
  method: string
  url: string
  internal: boolean
  headers: Record<string, string>
  aborted?: boolean
}

// React Native's XMLHttpRequest, as far as mocking needs it: the hooks its
// native networking module calls, so a mock goes through the real code path.
type RNXhr = XMLHttpRequest & {
  __didCreateRequest: (id: number) => void
  __didReceiveResponse: (id: number, status: number, headers: Record<string, string>, url: string) => void
  __didReceiveData: (id: number, data: string) => void
  __didCompleteResponse: (id: number, error: string, timedOut: boolean) => void
}

const META = Symbol('agent-bridge.xhr')
type Tagged = XMLHttpRequest & { [META]?: Meta }

const isRN = (xhr: XMLHttpRequest): xhr is RNXhr =>
  typeof (xhr as Partial<RNXhr>).__didReceiveResponse === 'function' &&
  typeof (xhr as Partial<RNXhr>).__didCompleteResponse === 'function'

function responseTextOf(xhr: XMLHttpRequest): string | undefined {
  try {
    if (xhr.responseType === '' || xhr.responseType === 'text') return xhr.responseText
    if (xhr.responseType === 'json') return JSON.stringify(xhr.response)
  } catch {
    // responseText throws for some response types; the log does without
  }
  return undefined
}

function track(xhr: XMLHttpRequest, entry: Entry): void {
  let error: string | undefined
  xhr.addEventListener('error', () => (error = OFFLINE_MESSAGE))
  xhr.addEventListener('timeout', () => (error = 'timed out'))
  xhr.addEventListener('abort', () => (error = 'aborted'))
  xhr.addEventListener('loadend', () => {
    finishEntry(entry, {
      status: error ? undefined : xhr.status,
      error,
      responseBody: error ? undefined : formatBody(responseTextOf(xhr)),
    })
  })
}

let fakeRequestId = 0

function fire(xhr: XMLHttpRequest, type: string): void {
  const Ctor =
    (type === 'readystatechange' ? undefined : globalThis.ProgressEvent) ??
    globalThis.Event
  xhr.dispatchEvent(new Ctor(type))
}

function respond(xhr: XMLHttpRequest, hit: Answer, url: string): void {
  const offline = isOffline(hit.response)
  const { status, text, headers } = responseParts(hit.response)

  if (isRN(xhr)) {
    const id = -++fakeRequestId
    xhr.__didCreateRequest(id)
    if (offline) return xhr.__didCompleteResponse(id, OFFLINE_MESSAGE, false)
    xhr.__didReceiveResponse(id, status, headers, url)
    if (xhr.responseType === 'arraybuffer' && typeof btoa === 'function') {
      xhr.__didReceiveData(id, btoa(unescape(encodeURIComponent(text))))
    } else if (xhr.responseType !== 'blob') {
      xhr.__didReceiveData(id, text)
    }
    return xhr.__didCompleteResponse(id, '', false)
  }

  // Browsers and anything else: shadow the read-only fields, then fire events.
  const define = (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values))
      Object.defineProperty(xhr, key, { value, configurable: true })
  }
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  let response: unknown = text
  if (xhr.responseType === 'json') {
    try {
      response = JSON.parse(text)
    } catch {
      response = null
    }
  }
  define({
    readyState: 4,
    status: offline ? 0 : status,
    statusText: '',
    responseURL: url,
    responseText: offline ? '' : text,
    response: offline ? '' : response,
    getAllResponseHeaders: () =>
      offline
        ? ''
        : Object.entries(lower)
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join(''),
    getResponseHeader: (name: string) => lower[name.toLowerCase()] ?? null,
  })
  fire(xhr, 'readystatechange')
  fire(xhr, offline ? 'error' : 'load')
  fire(xhr, 'loadend')
}

/** Patches XMLHttpRequest's prototype to log requests and answer them from mocks. */
export function patchXhr(state: NetworkState): (() => void) | null {
  const XHR = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest })
    .XMLHttpRequest
  if (typeof XHR !== 'function') return null
  const proto = XHR.prototype as Tagged
  const { open, send, setRequestHeader, abort } = proto

  proto.open = function (this: Tagged, method: string, url: string | URL, ...rest: unknown[]) {
    this[META] = {
      method: String(method).toUpperCase(),
      url: String(url),
      // Opened by the patched fetch's own original: fetch logs it already.
      internal: state.insideFetch > 0,
      headers: {},
    }
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest)
  } as typeof proto.open

  proto.setRequestHeader = function (this: Tagged, name: string, value: string) {
    const meta = this[META]
    if (meta) meta.headers[name.toLowerCase()] = value
    return setRequestHeader.call(this, name, value)
  }

  proto.abort = function (this: Tagged) {
    const meta = this[META]
    if (meta) meta.aborted = true
    return abort.call(this)
  }

  proto.send = function (this: Tagged, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = this[META]
    if (!meta || meta.internal || isSkipped(state, meta.url))
      return send.call(this, body)

    const { method, url } = meta
    const text = bodyText(body)
    const entry = startEntry(state, {
      method,
      url,
      requestBody: formatBody(text),
    })
    const candidates = matchingMocks(state, method, url)
    if (!candidates.length) {
      track(this, entry)
      return send.call(this, body)
    }

    const request = async () => mockRequest(method, url, meta.headers, text)
    answer(state, candidates, request).then(
      async (hit) => {
        if (!hit) {
          track(this, entry)
          return send.call(this, body)
        }
        entry.mocked = true
        await sleep(hit.mock.delayMs)
        if (meta.aborted) {
          finishEntry(entry, { error: 'aborted' })
          return
        }
        const offline = isOffline(hit.response)
        const { status, text: out } = responseParts(hit.response)
        finishEntry(
          entry,
          offline
            ? { error: `${OFFLINE_MESSAGE} (mocked offline)` }
            : { status, responseBody: formatBody(out) },
        )
        respond(this, hit, url)
      },
      (error: unknown) => {
        entry.mocked = true
        finishEntry(entry, { error: errorMessage(error) })
        respond(this, { mock: candidates[0]!, response: { offline: true } }, url)
      },
    )
  }

  return () => {
    Object.assign(proto, { open, send, setRequestHeader, abort })
  }
}
