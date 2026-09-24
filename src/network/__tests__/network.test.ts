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

describe('mocks', () => {
  beforeEach(() => {
    network('rn')
    tools = networkTools()
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
