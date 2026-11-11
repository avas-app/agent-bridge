import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { redactHeaders } from '../headers'
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
      expect(cut.requestHeaders?.authorization).toBe(`Bearer … (+${BEARER.length - 7} chars)`)
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

describe('redactHeaders', () => {
  const secrets: Record<string, string> = {
    apikey: 'sb_publishable_0123456789abcdef',
    'x-auth-token': 'tok_live_0123456789abcdef',
    'x-amz-security-token': 'FwoGZXIvYXdzEBYaDExample0123456789',
    'x-access-token': 'ya29.a0AfH6SMExample0123456',
    'x-csrf-token': 'csrf0123456789abcdef',
    'x-goog-api-key': 'AIzaSyExample0123456789abcdef',
    'api-key': 'abcdef0123456789',
    'x-session-token': 'sess0123456789abcdef',
    'x-api-key': 'abcdef0123456789',
    'x-signature': 'sha256=0123456789abcdef',
    'x-hub-signature-256': 'sha256=0123456789abcdef',
    'x-client-secret': 'shhh0123456789abcdef',
    'x-password': 'hunter2hunter2hunter2',
    'x-session-id': 'sess0123456789abcdef',
    cookie: 'sid=abcd1234efgh',
    'set-cookie': 'sid=abcd1234efgh; HttpOnly',
    'proxy-authorization': 'Basic dXNlcjpwYXNzd29yZA==',
  }

  test.each(Object.entries(secrets))('%s is cut', (name, value) => {
    const shown = redactHeaders({ [name]: value })[name]!
    const kept = shown.split('…')[0]!
    expect(kept.length).toBeLessThanOrEqual(Math.max(4, 'Basic '.length))
    expect(kept.length).toBeLessThanOrEqual(value.length / 4 + 6)
    expect(shown).toContain('… (+')
    expect(shown).not.toContain(value.slice(8, 16))
  })

  test('names match in any case and anywhere in the name', () => {
    expect(redactHeaders({ 'X-My-Auth': 'abcdefgh12345678' })['X-My-Auth']).toContain('… (+')
    expect(redactHeaders({ 'X-SUPABASE-APIKEY': 'abcdefgh12345678' })['X-SUPABASE-APIKEY']).toContain('… (+')
  })

  test('Authorization keeps the scheme word only', () => {
    expect(redactHeaders({ authorization: 'Bearer abc.def.ghi' }).authorization).toBe('Bearer … (+11 chars)')
    expect(redactHeaders({ authorization: 'Basic dXNlcjpwYXNz' }).authorization).toBe('Basic … (+12 chars)')
    expect(redactHeaders({ authorization: 'rawtokenrawtoken1' }).authorization).toBe('rawt… (+13 chars)')
  })

  test('short values keep at most a quarter, so a short secret is not shown', () => {
    expect(redactHeaders({ 'x-api-key': 'abcdefgh' })['x-api-key']).toBe('ab… (+6 chars)')
    expect(redactHeaders({ 'x-api-key': 'abc' })['x-api-key']).toBe('… (+3 chars)')
    expect(redactHeaders({ 'x-api-key': '' })['x-api-key']).toBe('… (+0 chars)')
  })

  test('ordinary headers pass through', () => {
    const plain = { accept: 'application/json', 'content-type': 'text/plain', 'x-trace': 'abc', 'user-agent': 'okhttp' }
    expect(redactHeaders(plain)).toEqual(plain)
  })
})

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
