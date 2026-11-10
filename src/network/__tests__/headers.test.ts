import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { networkTools } from '../index'
import { resetNetworkState } from '../state'
import type { LogEntry } from '../types'
import { FakeRNXHR, FakeXHR, nativeFetch, sendXhr, server, xhrFetch } from './fakes'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

const g = globalThis as unknown as Record<string, unknown>
const saved = { fetch: g.fetch, XMLHttpRequest: g.XMLHttpRequest }
const API = 'https://api.sprout.example'
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
const BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature'

let tools: Tools
const entry = (id: number, options?: object) => run(tools, 'net.entry', id, options) as LogEntry
const lastId = () => (run(tools, 'net.log') as LogEntry[])[0]!.id

afterEach(() => {
  resetNetworkState()
  Object.assign(g, saved)
})

for (const kind of ['web', 'rn'] as const) {
  describe(`headers (${kind})`, () => {
    beforeEach(() => {
      g.XMLHttpRequest = kind === 'rn' ? class extends FakeRNXHR {} : class extends FakeXHR {}
      g.fetch = kind === 'rn' ? xhrFetch : nativeFetch
      server.handle = () => ({
        status: 200,
        body: '{}',
        headers: { 'x-trace': 'abc', 'set-cookie': 'session=1234567890abcdef; HttpOnly' },
      })
      tools = networkTools()
    })

    test('a fetch logs request and response headers, shown by net.entry only', async () => {
      await fetch(`${API}/me`, { headers: { Accept: 'application/json', Authorization: BEARER } })
      await tick()
      const e = entry(lastId())
      expect(e.requestHeaders?.accept).toBe('application/json')
      expect(e.responseHeaders?.['x-trace']).toBe('abc')
      expect((run(tools, 'net.log') as LogEntry[])[0]!.requestHeaders).toBeUndefined()
      expect((run(tools, 'net.log', { full: true }) as LogEntry[])[0]!.responseHeaders).toBeUndefined()
    })

    test('Authorization, Cookie and Set-Cookie are cut to a prefix unless full', async () => {
      await fetch(`${API}/me`, { headers: { Authorization: BEARER, Cookie: 'a=b; token=secretsecretsecret' } })
      await tick()
      const id = lastId()
      const cut = entry(id)
      expect(cut.requestHeaders?.authorization).toBe(`Bearer e… (+${BEARER.length - 8} chars)`)
      expect(cut.requestHeaders?.cookie).not.toContain('secretsecret')
      expect(cut.responseHeaders?.['set-cookie']).not.toContain('1234567890abcdef')
      expect(cut.responseHeaders?.['x-trace']).toBe('abc')
      const whole = entry(id, { full: true })
      expect(whole.requestHeaders?.authorization).toBe(BEARER)
      expect(whole.responseHeaders?.['set-cookie']).toBe('session=1234567890abcdef; HttpOnly')
    })

    test('an XHR logs its headers too', async () => {
      class Probe extends (g.XMLHttpRequest as typeof XMLHttpRequest) {}
      g.XMLHttpRequest = Probe
      const xhr = new Probe()
      xhr.open('GET', `${API}/xhr`)
      xhr.setRequestHeader('X-Client', 'probe')
      await new Promise<void>((resolve) => {
        xhr.onloadend = () => resolve()
        xhr.send(null)
      })
      await tick()
      const e = entry(lastId())
      expect(e.requestHeaders?.['x-client']).toBe('probe')
      expect(e.responseHeaders?.['x-trace']).toBe('abc')
    })

    test('a mocked response logs the mock headers', async () => {
      run(tools, 'net.mock', '/mocked', { json: { ok: 1 }, headers: { 'X-Mock': 'yes' } })
      await fetch(`${API}/mocked`)
      await sendXhr('GET', `${API}/mocked`)
      await tick()
      const ids = (run(tools, 'net.log') as LogEntry[]).map((e) => e.id)
      for (const id of ids) {
        expect(entry(id).responseHeaders?.['x-mock']).toBe('yes')
        expect(entry(id).responseHeaders?.['content-type']).toBe('application/json')
      }
    })
  })
}

describe('log size', () => {
  test('logSize sets how many requests are kept', async () => {
    g.XMLHttpRequest = class extends FakeXHR {}
    g.fetch = nativeFetch
    tools = networkTools({ logSize: 3 })
    for (let i = 0; i < 5; i++) await fetch(`${API}/n/${i}`)
    expect((run(tools, 'net.log', { limit: 1000 }) as LogEntry[]).map((e) => e.url)).toEqual([
      `${API}/n/4`,
      `${API}/n/3`,
      `${API}/n/2`,
    ])
  })
})
