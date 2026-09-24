// A fake network: a route table standing in for servers, a browser-style
// XMLHttpRequest, React Native's flavour of it, and two kinds of fetch.
export type Reply = { status: number; body: string } | 'offline'
export type Server = (method: string, url: string, body?: string) => Reply

export const server = {
  handle: ((_m, url) => ({ status: 200, body: JSON.stringify({ real: url }) })) as Server,
  hits: [] as string[],
}

const reach = (method: string, url: string, body?: string): Reply => {
  server.hits.push(`${method} ${url}`)
  return server.handle(method, url, body)
}

/** Browser-style XHR: on-handlers fire from dispatchEvent. */
export class FakeXHR extends EventTarget {
  readyState = 0
  status = 0
  responseText = ''
  response: unknown = ''
  responseType: XMLHttpRequestResponseType = ''
  method = ''
  url = ''
  onreadystatechange: ((e: Event) => void) | null = null
  onload: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  onloadend: ((e: Event) => void) | null = null

  open(method: string, url: string) {
    this.method = method
    this.url = url
    this.readyState = 1
  }
  setRequestHeader(_name: string, _value: string) {}
  abort() {}
  send(body?: string | null) {
    setTimeout(() => this.deliver(reach(this.method, this.url, body ?? undefined)), 1)
  }
  getAllResponseHeaders() {
    return ''
  }
  protected deliver(reply: Reply) {
    this.readyState = 4
    if (reply === 'offline') {
      this.dispatchEvent(new Event('readystatechange'))
      this.dispatchEvent(new Event('error'))
    } else {
      this.status = reply.status
      this.responseText = reply.body
      this.response = this.responseType === 'json' ? JSON.parse(reply.body) : reply.body
      this.dispatchEvent(new Event('readystatechange'))
      this.dispatchEvent(new Event('load'))
    }
    this.dispatchEvent(new Event('loadend'))
  }
  override dispatchEvent(event: Event): boolean {
    const result = super.dispatchEvent(event)
    const handler = (this as unknown as Record<string, unknown>)[`on${event.type}`]
    if (typeof handler === 'function') handler.call(this, event)
    return result
  }
}

/** React Native's XHR: the native module answers through __did* hooks. */
export class FakeRNXHR extends FakeXHR {
  _requestId: number | null = null
  override send(body?: string | null) {
    const id = Math.floor(Math.random() * 1e6) + 1
    this.__didCreateRequest(id)
    setTimeout(() => {
      const reply = reach(this.method, this.url, body ?? undefined)
      if (reply === 'offline') return this.__didCompleteResponse(id, 'Could not connect', false)
      this.__didReceiveResponse(id, reply.status, {}, this.url)
      this.__didReceiveData(id, reply.body)
      this.__didCompleteResponse(id, '', false)
    }, 1)
  }
  __didCreateRequest(id: number) {
    this._requestId = id
  }
  __didReceiveResponse(id: number, status: number, _headers?: object, _url?: string) {
    if (id === this._requestId) this.status = status
  }
  __didReceiveData(id: number, data: string) {
    if (id !== this._requestId) return
    this.responseText = data
    this.response = this.responseType === 'json' ? JSON.parse(data) : data
  }
  __didCompleteResponse(id: number, error: string, _timedOut?: boolean) {
    if (id !== this._requestId) return
    this.readyState = 4
    this.dispatchEvent(new Event('readystatechange'))
    this.dispatchEvent(new Event(error ? 'error' : 'load'))
    this.dispatchEvent(new Event('loadend'))
  }
}

/** A native fetch, as on the web or with expo/fetch. */
export async function nativeFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : (input as Request).url
  const reply = reach(init?.method ?? 'GET', url, init?.body as string | undefined)
  if (reply === 'offline') throw new TypeError('fetch failed')
  return new Response(reply.body, {
    status: reply.status,
    headers: { 'content-type': 'application/json' },
  })
}

/** React Native's fetch (whatwg-fetch): builds an XHR from the global. */
export function xhrFetch(input: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new globalThis.XMLHttpRequest()
    xhr.onload = () =>
      resolve(new Response(xhr.responseText, { status: xhr.status }))
    xhr.onerror = () => reject(new TypeError('Network request failed'))
    xhr.open(init?.method ?? 'GET', String(input), true)
    xhr.send((init?.body as string | undefined) ?? null)
  })
}

/** Sends a plain XHR and resolves with it once done. */
export function sendXhr(
  method: string,
  url: string,
  body?: string,
  responseType: XMLHttpRequestResponseType = '',
): Promise<XMLHttpRequest & { failed?: boolean }> {
  return new Promise((resolve) => {
    const xhr = new globalThis.XMLHttpRequest() as XMLHttpRequest & { failed?: boolean }
    xhr.responseType = responseType
    xhr.onerror = () => {
      xhr.failed = true
    }
    xhr.onloadend = () => resolve(xhr)
    xhr.open(method, url)
    xhr.send(body ?? null)
  })
}
