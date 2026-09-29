import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { mock, mockRequests, networkTools } from '../index'
import { networkState, resetNetworkState } from '../state'
import type { LogEntry } from '../types'
import {
  FakeRNXHR,
  FakeXHR,
  nativeFetch,
  sendXhr,
  server,
  xhrFetch,
} from './fakes'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

const g = globalThis as unknown as Record<string, unknown>
const saved = { fetch: g.fetch, XMLHttpRequest: g.XMLHttpRequest }
const API = 'https://api.sprout.example'

/** Installs a fake network: 'web' has its own fetch, 'rn' builds fetch on XHR. */
function network(kind: 'web' | 'rn') {
  g.XMLHttpRequest = kind === 'rn' ? class extends FakeRNXHR {} : class extends FakeXHR {}
  g.fetch = kind === 'rn' ? xhrFetch : nativeFetch
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

let tools: Tools
const log = (filter?: object) => run(tools, 'net.log', filter) as LogEntry[]

beforeEach(() => {
  server.handle = (_m, url) => ({ status: 200, body: JSON.stringify({ real: url }) })
  server.hits = []
})

afterEach(() => {
  resetNetworkState()
  Object.assign(g, saved)
})

for (const kind of ['web', 'rn'] as const) {
  describe(`logging (${kind})`, () => {
    beforeEach(() => {
      network(kind)
      tools = networkTools()
    })

    test('logs a fetch once, with status, time and bodies', async () => {
      const res = await fetch(`${API}/plants`, {
        method: 'POST',
        body: '{ "name": "Fern" }',
      })
      expect(await res.json()).toEqual({ real: `${API}/plants` })
      await tick()
      const entries = log()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        method: 'POST',
        url: `${API}/plants`,
        status: 200,
        requestBody: '{"name":"Fern"}',
        responseBody: `{"real":"${API}/plants"}`,
      })
      expect(entries[0]!.mocked).toBeUndefined()
      expect(entries[0]!.pending).toBeUndefined()
    })

    test('logs a plain XHR', async () => {
      const xhr = await sendXhr('get', `${API}/flags`)
      expect(xhr.status).toBe(200)
      expect(log()).toMatchObject([{ method: 'GET', url: `${API}/flags`, status: 200 }])
    })

    test('records network failures', async () => {
      server.handle = () => 'offline'
      await expect(fetch(`${API}/plants`)).rejects.toThrow()
      expect(log()[0]!.error).toBeString()
      expect(log()[0]!.status).toBeUndefined()
    })
  })
}

describe('log', () => {
  beforeEach(() => {
    network('web')
    tools = networkTools()
  })

  test('skips Metro and Expo dev-server traffic', async () => {
    networkState().devHost = '192.168.1.5:8081'
    await fetch('http://192.168.1.5:8081/api/anything')
    await fetch('http://localhost:8081/symbolicate', { method: 'POST' })
    await fetch('http://localhost:8081/index.bundle?platform=ios')
    await fetch('http://localhost:8081/inspector/device')
    await fetch('http://localhost:8081/expo-dev-plugins/x')
    await fetch(`${API}/v1/status`)
    expect(log().map((e) => e.url)).toEqual([`${API}/v1/status`])
  })

  test('skips extra URLs from options', async () => {
    tools = networkTools({ skip: ['analytics', /\/beacon$/] })
    await fetch('https://analytics.example/e')
    await fetch(`${API}/beacon`)
    expect(log()).toEqual([])
  })

  test('filters, limits, lists newest first and clears', async () => {
    for (const path of ['/one', '/two', '/three']) await fetch(`${API}${path}`)
    await fetch(`${API}/one`, { method: 'DELETE' })
    expect(log({ limit: 2 }).map((e) => `${e.method} ${e.url}`)).toEqual([
      `DELETE ${API}/one`,
      `GET ${API}/three`,
    ])
    expect(log({ url: '/one', method: 'get' })).toHaveLength(1)
    expect(log({ clear: true })).toHaveLength(4)
    expect(log()).toEqual([])
    await fetch(`${API}/d`)
    expect(run(tools, 'net.clear')).toBe(1)
  })

  test('keeps the last 100 requests', async () => {
    for (let i = 0; i < 105; i++) await fetch(`${API}/n/${i}`)
    const all = log({ limit: 1000 })
    expect(all).toHaveLength(100)
    expect(all.at(-1)!.url).toBe(`${API}/n/5`)
  })

  test('cuts bodies at about 2 KB', async () => {
    server.handle = () => ({ status: 200, body: 'x'.repeat(5000) })
    await fetch(`${API}/big`)
    await tick()
    const body = log()[0]!.responseBody!
    expect(body.length).toBeLessThan(2100)
    expect(body).toEndWith('(+2952 chars)')
  })
})

describe('log entries', () => {
  beforeEach(() => {
    network('web')
    tools = networkTools()
  })

  test('startedAt is epoch ms and since filters on it', async () => {
    const before = Date.now()
    await fetch(`${API}/a`)
    await tick(20)
    const mid = Date.now()
    await fetch(`${API}/b`)
    const all = log()
    expect(all[1]!.startedAt).toBeGreaterThanOrEqual(before)
    expect(all[0]!.startedAt).toBeGreaterThanOrEqual(mid)
    expect(log({ since: mid }).map((e) => e.url)).toEqual([`${API}/b`])
    expect(log({ since: before })).toHaveLength(2)
  })

  test('full: true and net.entry return whole bodies', async () => {
    const big = JSON.stringify({ items: 'x'.repeat(5000) })
    server.handle = () => ({ status: 200, body: big })
    await fetch(`${API}/big`, { method: 'POST', body: JSON.stringify({ q: 'y'.repeat(3000) }) })
    await tick()
    const id = log()[0]!.id
    expect(log()[0]!.responseBody).toContain('… (+')
    expect(log({ full: true })[0]!.responseBody).toBe(big)
    expect(log({ full: true })[0]!.requestBody).toHaveLength(3000 + 8)
    const entry = run(tools, 'net.entry', id) as LogEntry
    expect(entry.responseBody).toBe(big)
    expect(() => run(tools, 'net.entry', 999)).toThrow('No logged request')
  })

  test('net.mockFromLog mocks a logged response, with a deep patch', async () => {
    server.handle = () => ({
      status: 201,
      body: JSON.stringify({ user: { name: 'Fern', tags: ['a'], pad: 'x'.repeat(3000) }, ok: true }),
    })
    await fetch(`${API}/me?x=1`)
    await tick()
    const id = log()[0]!.id
    server.handle = () => ({ status: 500, body: 'down' })
    run(tools, 'net.mockFromLog', id, { user: { name: 'Moss', tags: ['b'] } })
    const res = await fetch(`${API}/me?x=1`)
    expect(res.status).toBe(201)
    const json = (await res.json()) as { user: Record<string, unknown>; ok: boolean }
    expect(json.user).toEqual({ name: 'Moss', tags: ['b'], pad: 'x'.repeat(3000) })
    expect(json.ok).toBe(true)
    // the mock is for that URL only, and for that method
    expect((await fetch(`${API}/me?x=12`)).status).toBe(500)
    expect((await fetch(`${API}/me?x=1`, { method: 'POST' })).status).toBe(500)
  })

  test('net.mockFromLog refuses what it cannot copy', async () => {
    server.handle = () => ({ status: 200, body: 'plain' })
    await fetch(`${API}/t`)
    await tick()
    const id = log()[0]!.id
    expect(() => run(tools, 'net.mockFromLog', id, { a: 1 })).toThrow('not JSON')
    run(tools, 'net.mockFromLog', id)
    expect(await (await fetch(`${API}/t`)).text()).toBe('plain')
    run(tools, 'net.mock', '/fails', { offline: true })
    await fetch(`${API}/fails`).catch(() => {})
    expect(() => run(tools, 'net.mockFromLog', log()[0]!.id)).toThrow('no response')
  })
})

describe('whole bodies', () => {
  const entry = (id: number) => run(tools, 'net.entry', id) as LogEntry
  const failsWith = (id: number, text: string) =>
    expect(() => run(tools, 'net.mockFromLog', id)).toThrow(text)

  beforeEach(() => {
    network('web')
    tools = networkTools()
  })

  test('keeps the text as sent: a big id survives net.entry and the mock', async () => {
    const raw = '{"id": 1234567890123456789, "n": 1}'
    server.handle = () => ({ status: 200, body: raw })
    await fetch(`${API}/big-int`)
    await tick()
    const id = log()[0]!.id
    expect(log()[0]!.responseBody).toBe('{"id":1234567890123456789,"n":1}'.replace('1234567890123456789', '1234567890123456800'))
    expect(entry(id).responseBody).toBe(raw)
    run(tools, 'net.mockFromLog', id)
    const res = await fetch(`${API}/big-int`)
    expect(await res.text()).toBe(raw)
    expect(res.headers.get('content-type')).toBe('application/json')
  })

  test('a body over 1 MB is not kept whole and cannot be mocked', async () => {
    server.handle = () => ({ status: 200, body: JSON.stringify({ x: 'a'.repeat(1_000_001) }) })
    await fetch(`${API}/huge`)
    await tick()
    const id = log()[0]!.id
    expect(entry(id).truncated).toBe(true)
    expect(entry(id).responseBody).toContain('… (+')
    failsWith(id, 'too large')
  })

  test('the total kept is capped: oldest bodies go first, previews stay', async () => {
    server.handle = () => ({ status: 200, body: JSON.stringify({ x: 'a'.repeat(900_000) }) })
    for (let i = 0; i < 8; i++) await fetch(`${API}/poll/${i}`)
    await tick(30)
    const all = log({ limit: 100 }).reverse()
    const oldest = all[0]!.id
    const newest = all.at(-1)!.id
    expect(entry(oldest).truncated).toBe(true)
    expect(entry(oldest).responseBody).toContain('… (+')
    failsWith(oldest, 'dropped')
    expect(entry(newest).truncated).toBeUndefined()
    expect(entry(newest).responseBody).toHaveLength(900_008)
    const whole = all.filter((e) => !entry(e.id).truncated).length
    expect(whole).toBeLessThanOrEqual(4)
    expect(whole).toBeGreaterThan(0)
  })

  test('a fetch response that is not text is not copied', async () => {
    resetNetworkState()
    g.fetch = async () => new Response('PNG', { headers: { 'content-type': 'image/png' } })
    tools = networkTools()
    await fetch(`${API}/logo.png`)
    await tick()
    failsWith(log()[0]!.id, 'not captured')
  })

  test('a response still being read is refused, then copied once read', async () => {
    resetNetworkState()
    g.fetch = async () =>
      ({
        status: 200,
        headers: { get: () => 'application/json' },
        clone: () => ({ text: () => new Promise<string>((r) => setTimeout(() => r('{"a":1}'), 30)) }),
      }) as unknown as Response
    tools = networkTools()
    await fetch(`${API}/slow`)
    const id = log()[0]!.id
    failsWith(id, 'still being read')
    await tick(60)
    run(tools, 'net.mockFromLog', id)
    expect(await (await fetch(`${API}/slow`)).text()).toBe('{"a":1}')
  })

  test('an XHR blob response is not copied', async () => {
    await sendXhr('GET', `${API}/file`, undefined, 'blob')
    failsWith(log()[0]!.id, 'not captured')
  })
})

describe('log filters', () => {
  beforeEach(() => {
    network('web')
    tools = networkTools()
  })

  test('since rejects what is not an epoch time; sinceId filters by id', async () => {
    await fetch(`${API}/a`)
    await fetch(`${API}/b`)
    const [b, a] = log()
    expect(() => log({ since: 42 })).toThrow('epoch time')
    expect(log({ sinceId: a!.id }).map((e) => e.id)).toEqual([b!.id])
  })
})

describe('mocks', () => {
  beforeEach(() => {
    network('rn')
    tools = networkTools()
  })

  test('priority beats age, and a negative one is a fallback', async () => {
    run(tools, 'net.mock', { url: '/ride/cancel', method: 'POST' }, { json: { ok: 'specific' } }, { priority: 1 })
    run(tools, 'net.mock', { url: '/', method: 'POST' }, { json: { ok: 'generic' } })
    run(tools, 'net.mock', '/ride', { json: { ok: 'fallback' } }, { priority: -1 })
    const post = (path: string) => fetch(`${API}${path}`, { method: 'POST' }).then((r) => r.json())
    expect(await post('/ride/cancel')).toEqual({ ok: 'specific' })
    expect(await post('/other')).toEqual({ ok: 'generic' })
    expect(await (await fetch(`${API}/ride/x`)).json()).toEqual({ ok: 'fallback' })
    const listed = run(tools, 'net.mocks') as Array<{ priority?: number }>
    expect(listed.map((m) => m.priority)).toEqual([1, undefined, -1])
  })

  test('an app mock with a priority still comes after agent mocks', async () => {
    mock('/x', { body: 'app' }, { priority: 5 })
    expect(await (await fetch(`${API}/x`)).text()).toBe('app')
    run(tools, 'net.mock', '/x', { body: 'agent' })
    expect(await (await fetch(`${API}/x`)).text()).toBe('agent')
  })

  test('priority must be a finite number', () => {
    expect(() => run(tools, 'net.mock', '/x', { status: 200 }, { priority: 'high' })).toThrow('finite')
    expect(() => run(tools, 'net.mock', '/x', { status: 200 }, { priority: NaN })).toThrow('finite')
  })

  test('shadows only reports certain cases', () => {
    const add = (match: unknown, response: unknown) =>
      run(tools, 'net.mock', match, response) as { id: string; shadows?: string[] }
    const regex = add({ url: { regex: '^https://a/cancel$' } }, { status: 200 })
    const anyMethod = add('/ride/cancel', { status: 200 })
    // a regex old mock is never judged; a new mock for one method can't be sure of a method-less old one
    expect(add({ url: '/', method: 'POST' }, { status: 200 }).shadows).toBeUndefined()
    // a regex new mock isn't judged either
    expect(add({ url: { regex: '/' } }, { status: 200 }).shadows).toBeUndefined()
    const covering = add('/', { status: 200 })
    expect(covering.shadows).toContain(anyMethod.id)
    expect(covering.shadows).not.toContain(regex.id)
  })

  test('warns when a new mock shadows an earlier agent mock', () => {
    const first = run(tools, 'net.mock', { url: '/ride/cancel', method: 'POST' }, { status: 200 }) as { id: string; shadows?: string[] }
    expect(first.shadows).toBeUndefined()
    const broad = run(tools, 'net.mock', { url: '/', method: 'POST' }, { status: 200 }) as { id: string; shadows?: string[] }
    expect(broad.shadows).toEqual([first.id])
    const other = run(tools, 'net.mock', { url: '/', method: 'GET' }, { status: 200 }) as { shadows?: string[] }
    expect(other.shadows).toBeUndefined()
    const lower = run(tools, 'net.mock', '/ride', { status: 200 }, { priority: -1 }) as { shadows?: string[] }
    expect(lower.shadows).toBeUndefined()
  })

  test('answers from a mock, logged as mocked, without reaching the server', async () => {
    const { id } = run(tools, 'net.mock', { url: '/inbox' }, { status: 500, json: { error: 'boom' } }) as { id: string }
    expect(id).toBeString()
    const res = await fetch(`${API}/inbox`)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'boom' })
    expect(server.hits).toEqual([])
    expect(log()[0]).toMatchObject({ status: 500, mocked: true, responseBody: '{"error":"boom"}' })
  })

  test('matches on method and regex; newest mock wins', async () => {
    run(tools, 'net.mock', '/plants', { body: 'old' })
    run(tools, 'net.mock', '/plants', { body: 'new' })
    run(tools, 'net.mock', { url: { regex: 'plants/\\d+$' }, method: 'delete' }, { status: 204 })
    expect((await fetch(`${API}/plants/7`, { method: 'DELETE' })).status).toBe(204)
    expect(await (await fetch(`${API}/plants/7`)).text()).toBe('new')
    expect(await (await fetch(`${API}/flags`)).json()).toEqual({ real: `${API}/flags` })
  })

  test('times: answers n requests, then the real network', async () => {
    run(tools, 'net.mock', '/flags', { json: { shop: false } }, { times: 1 })
    expect(await (await fetch(`${API}/flags`)).json()).toEqual({ shop: false })
    expect(await (await fetch(`${API}/flags`)).json()).toEqual({ real: `${API}/flags` })
  })

  test('delayMs holds the answer back', async () => {
    run(tools, 'net.mock', '/slow', { json: 1 }, { delayMs: 60 })
    const t0 = Date.now()
    await fetch(`${API}/slow`)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55)
    expect(log()[0]!.ms).toBeGreaterThanOrEqual(55)
  })

  test('offline rejects like React Native does', async () => {
    run(tools, 'net.mock', '/plants', { offline: true })
    const error = await fetch(`${API}/plants`).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe('Network request failed')
    expect(log()[0]).toMatchObject({ mocked: true })
    expect(log()[0]!.error).toContain('offline')
  })

  test('mocks a plain XHR on React Native through its native hooks', async () => {
    run(tools, 'net.mock', '/flags', { json: { shop: false } })
    const xhr = await sendXhr('GET', `${API}/flags`, undefined, 'json')
    expect(xhr.status).toBe(200)
    expect(xhr.response).toEqual({ shop: false })
    run(tools, 'net.mock', '/down', { offline: true })
    expect((await sendXhr('GET', `${API}/down`)).failed).toBe(true)
    expect(server.hits).toEqual([])
  })

  test('mocks a plain XHR in a browser-style runtime', async () => {
    resetNetworkState()
    network('web')
    tools = networkTools()
    run(tools, 'net.mock', '/flags', { status: 201, body: 'hi', headers: { 'X-A': '1' } })
    const xhr = await sendXhr('GET', `${API}/flags`)
    expect([xhr.readyState, xhr.status, xhr.responseText]).toEqual([4, 201, 'hi'])
    expect(xhr.getResponseHeader('x-a')).toBe('1')
    expect(log()[0]).toMatchObject({ status: 201, mocked: true })
  })

  test('a handler keeps state, like a fake backend', async () => {
    const plants = [{ id: 'p1', name: 'Fern' }]
    mockRequests([
      { match: { url: '/plants', method: 'GET' }, response: () => ({ json: plants }) },
      {
        match: { url: '/plants', method: 'POST' },
        response: (req) => {
          const plant = { id: `p${plants.length + 1}`, ...(req.json() as object) } as (typeof plants)[number]
          plants.push(plant)
          return { status: 201, json: plant }
        },
      },
    ])
    const created = await fetch(`${API}/plants`, { method: 'POST', body: JSON.stringify({ name: 'Basil' }) })
    expect(await created.json()).toEqual({ id: 'p2', name: 'Basil' })
    expect(await (await fetch(`${API}/plants`)).json()).toHaveLength(2)
    expect(server.hits).toEqual([])
  })

  test('a handler returning undefined lets the request through', async () => {
    mock('/plants', (req) => (req.url.endsWith('/1') ? { json: 'one' } : undefined))
    expect(await (await fetch(`${API}/plants/1`)).json()).toBe('one')
    expect(await (await fetch(`${API}/plants/2`)).json()).toEqual({ real: `${API}/plants/2` })
  })

  test('agent mocks beat app mocks; restore removes only agent mocks', async () => {
    const stop = mockRequests([{ match: '/inbox', response: { json: 'app' } }])
    run(tools, 'net.mock', '/inbox', { json: 'agent-1' })
    run(tools, 'net.mock', '/flags', { json: 'agent-2' })
    mock('/inbox', { json: 'app, newer' })
    expect(await (await fetch(`${API}/inbox`)).json()).toBe('agent-1')
    expect((run(tools, 'net.mocks') as unknown[]).length).toBe(4)

    expect(run(tools, 'net.restore')).toBe(2)
    expect(await (await fetch(`${API}/inbox`)).json()).toBe('app, newer')
    expect(await (await fetch(`${API}/flags`)).json()).toEqual({ real: `${API}/flags` })
    stop()
    expect((run(tools, 'net.mocks') as unknown[]).length).toBe(1)
  })

  test('net.mocks cuts big response bodies like net.log unless full', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `plant ${i}` }))
    run(tools, 'net.mock', '/big-json', { json: { items } })
    run(tools, 'net.mock', '/big-body', { body: 'x'.repeat(5000) })
    run(tools, 'net.mock', '/small', { json: { ok: true } })
    mock({ url: /\/app-regex$/, method: 'GET' }, { status: 204 })
    type Listed = { match: unknown; response: Record<string, unknown>; truncated?: boolean }
    const listed = run(tools, 'net.mocks') as Listed[]
    const [small, body, json, app] = listed
    expect(small).toMatchObject({ response: { json: { ok: true } } })
    expect(small!.truncated).toBeUndefined()
    const whole = JSON.stringify({ items })
    expect(json!.truncated).toBe(true)
    expect(json!.response.json).toBe(`${whole.slice(0, 2048)}… (+${whole.length - 2048} chars)`)
    expect(body).toMatchObject({ truncated: true, response: { body: `${'x'.repeat(2048)}… (+2952 chars)` } })
    // a regex match prints as its source instead of {}
    expect(app!.match).toEqual({ url: '/\\/app-regex$/', method: 'GET' })

    const full = run(tools, 'net.mocks', { full: true }) as Listed[]
    expect(full[2]!.response.json).toEqual({ items })
    expect(full[1]!.response.body).toBe('x'.repeat(5000))
    expect(full.some((m) => m.truncated)).toBe(false)
  })

  test('unmock takes one agent mock by id, or all of them', () => {
    const a = run(tools, 'net.mock', '/a', { json: 1 }) as { id: string }
    run(tools, 'net.mock', '/b', { json: 2 })
    const app = mock('/c', { json: 3 })
    expect(run(tools, 'net.unmock', app.id)).toBe(0)
    expect(run(tools, 'net.unmock', a.id)).toBe(1)
    expect(run(tools, 'net.unmock')).toBe(1)
    expect((run(tools, 'net.mocks') as unknown[]).length).toBe(1)
  })

  test('an app mock with the same id replaces the old one', async () => {
    mock('/flags', { json: 1 }, { id: 'flags' })
    mock('/flags', { json: 2 }, { id: 'flags' })
    expect((run(tools, 'net.mocks') as unknown[]).length).toBe(1)
    expect(await (await fetch(`${API}/flags`)).json()).toBe(2)
  })

  test('rejects a mock without a match or response', () => {
    expect(() => run(tools, 'net.mock', {}, { status: 500 })).toThrow('needs a match')
    expect(() => run(tools, 'net.mock', '/x', 500)).toThrow('response must be an object')
  })
})

describe('install', () => {
  test('patches once however often tools are built', async () => {
    network('rn')
    const XHRClass = g.XMLHttpRequest as typeof FakeXHR
    const send = XHRClass.prototype.send
    networkTools()
    const patchedFetch = g.fetch
    const patchedSend = XHRClass.prototype.send
    expect(patchedFetch).not.toBe(xhrFetch)
    expect(patchedSend).not.toBe(send)

    tools = networkTools()
    mock('/x', { json: 1 })
    networkTools()
    expect(g.fetch).toBe(patchedFetch)
    expect(XHRClass.prototype.send).toBe(patchedSend)

    await fetch(`${API}/plants`)
    expect(log()).toHaveLength(1)

    resetNetworkState()
    expect(g.fetch).toBe(xhrFetch)
    expect(XHRClass.prototype.send).toBe(send)
  })
})
