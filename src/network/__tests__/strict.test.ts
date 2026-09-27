import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { compileRoute } from '../api'
import { mock, mockApi, networkTools, strictNetwork } from '../index'
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

let tools: Tools
let consoleError: ReturnType<typeof spyOn>
const log = () => run(tools, 'net.log') as LogEntry[]
const strict = (...args: unknown[]) =>
  run(tools, 'net.strict', ...args) as {
    strict: boolean
    source: string | null
    allow: string[]
    blocked: Array<{ method: string; url: string; count: number }>
  }

beforeEach(() => {
  server.handle = (_m, url) => ({ status: 200, body: JSON.stringify({ real: url }) })
  server.hits = []
  consoleError = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  resetNetworkState()
  Object.assign(g, saved)
  consoleError.mockRestore()
})

for (const kind of ['web', 'rn'] as const) {
  describe(`strict mode (${kind})`, () => {
    beforeEach(() => {
      g.XMLHttpRequest = kind === 'rn' ? class extends FakeRNXHR {} : class extends FakeXHR {}
      g.fetch = kind === 'rn' ? xhrFetch : nativeFetch
      tools = networkTools()
    })

    test('fails an unmocked fetch with a 501 and says which request', async () => {
      const off = strictNetwork()
      mock('/plants', { json: ['fern'] })
      expect(await (await fetch(`${API}/plants`)).json()).toEqual(['fern'])

      const res = await fetch(`${API}/me`, { method: 'POST' })
      expect(res.status).toBe(501)
      expect(await res.json()).toEqual({
        error: `agent-bridge strict network: no mock for POST ${API}/me`,
      })
      expect(server.hits).toEqual([])
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(String(consoleError.mock.calls[0]![0])).toContain(`POST ${API}/me`)
      expect(log()[0]).toMatchObject({ method: 'POST', status: 501, blocked: true })
      expect(strict().blocked).toEqual([{ method: 'POST', url: `${API}/me`, count: 1 }])

      off()
      expect(await (await fetch(`${API}/me`)).json()).toEqual({ real: `${API}/me` })
    })

    test('fails an unmocked plain XHR the same way', async () => {
      strictNetwork()
      const xhr = await sendXhr('GET', `${API}/flags`)
      expect(xhr.status).toBe(501)
      expect(xhr.responseText).toContain('no mock for GET')
      expect(server.hits).toEqual([])
    })

    test('blocks when every matching handler passes', async () => {
      strictNetwork()
      mock('/plants', () => undefined)
      expect((await fetch(`${API}/plants`)).status).toBe(501)
    })

    test('lets allowed URLs through', async () => {
      strictNetwork({ allow: ['cdn.example', /\/health$/] })
      expect((await fetch('https://cdn.example/a.png')).status).toBe(200)
      expect((await fetch(`${API}/health`)).status).toBe(200)
      expect((await fetch(`${API}/other`)).status).toBe(501)
      expect(server.hits).toHaveLength(2)
    })
  })
}

describe('net.strict', () => {
  beforeEach(() => {
    g.XMLHttpRequest = class extends FakeRNXHR {}
    g.fetch = nativeFetch
    tools = networkTools()
  })

  test('reads, sets and restores the agent setting over the app one', async () => {
    expect(strict()).toMatchObject({ strict: false, source: null })
    strictNetwork({ allow: ['cdn'] })
    expect(strict()).toMatchObject({ strict: true, source: 'app', allow: ['cdn'] })

    expect(strict(false)).toMatchObject({ strict: false, source: 'agent' })
    expect((await fetch(`${API}/x`)).status).toBe(200)

    strict({ allow: [{ regex: '/ok$' }], status: 418 })
    expect((await fetch(`${API}/ok`)).status).toBe(200)
    expect((await fetch(`${API}/x`)).status).toBe(418)

    run(tools, 'net.restore')
    expect(strict()).toMatchObject({ strict: true, source: 'app' })
    expect((await fetch(`${API}/x`)).status).toBe(501)
  })

  test('counts repeats; net.clear empties the list', async () => {
    strict(true)
    await fetch(`${API}/x`)
    await fetch(`${API}/x`)
    expect(strict().blocked).toEqual([{ method: 'GET', url: `${API}/x`, count: 2 }])
    run(tools, 'net.clear')
    expect(strict().blocked).toEqual([])
  })

  test('rejects nonsense', () => {
    expect(() => strict('yes')).toThrow('Pass true, false, null')
  })
})

describe('mockApi', () => {
  beforeEach(() => {
    g.XMLHttpRequest = class extends FakeRNXHR {}
    g.fetch = xhrFetch
    tools = networkTools()
  })

  test('answers routes under a base URL, with params and query', async () => {
    const plants = [{ id: 'p1' }, { id: 'p 2' }]
    const remove = mockApi(`${API}/`, {
      'GET /plants': { json: plants },
      'GET /plants/:id': ({ params, query }) => ({
        json: { ...plants.find((p) => p.id === params.id), query },
      }),
      'POST /plants': (req) => ({ status: 201, json: req.json() }),
      '/files/*': ({ params }) => ({ body: params['*'] }),
    })
    expect(await (await fetch(`${API}/plants`)).json()).toEqual(plants)
    expect(await (await fetch(`${API}/plants?page=2`)).json()).toEqual(plants)
    expect(await (await fetch(`${API}/plants/p%202?x=1`)).json()).toEqual({ id: 'p 2', query: { x: '1' } })
    const created = await fetch(`${API}/plants`, { method: 'POST', body: '{"id":"p3"}' })
    expect([created.status, await created.json()]).toEqual([201, { id: 'p3' }])
    expect(await (await fetch(`${API}/files/a/b.txt`, { method: 'PUT' })).text()).toBe('a/b.txt')
    // Not under the base URL, or a deeper path: through to the network.
    expect(await (await fetch('https://other.example/plants')).json()).toEqual({ real: 'https://other.example/plants' })
    expect((await fetch(`${API}/plants/p1/leaves`)).status).toBe(200)
    expect(server.hits).toEqual(['GET https://other.example/plants', `GET ${API}/plants/p1/leaves`])

    remove()
    expect((run(tools, 'net.mocks') as unknown[]).length).toBe(0)
  })

  test('an id makes a second registration replace the first', () => {
    mockApi(API, { 'GET /me': { json: 1 } }, { id: 'me' })
    mockApi(API, { 'GET /me': { json: 2 } }, { id: 'me' })
    expect(run(tools, 'net.mocks')).toMatchObject([{ id: 'me GET /me', response: { json: 2 } }])
  })

  test('compiles routes', () => {
    expect(compileRoute('', 'GET /a/:b').regex.test('https://x.example/a/1?q')).toBe(true)
    expect(compileRoute('', '/a/:b').method).toBeUndefined()
    expect(compileRoute('https://x.example/v1', 'get /a').regex.test('https://x.example/a')).toBe(false)
    expect(() => compileRoute('', 'GET plants')).toThrow('Bad route')
  })
})
