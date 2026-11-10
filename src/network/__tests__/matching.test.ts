import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { mock, networkTools } from '../index'
import { resetNetworkState } from '../state'
import type { LogEntry } from '../types'
import { FakeRNXHR, FakeXHR, nativeFetch, server, xhrFetch } from './fakes'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

const g = globalThis as unknown as Record<string, unknown>
const saved = { fetch: g.fetch, XMLHttpRequest: g.XMLHttpRequest }
const API = 'https://api.sprout.example'
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

let tools: Tools
const mockIt = (match: unknown, response: unknown = { json: { mocked: true } }, options?: object) =>
  run(tools, 'net.mock', match, response, options) as { id: string; shadows?: string[]; matches: string }
const get = async (path: string, init?: RequestInit) => (await fetch(`${API}${path}`, init)).json()
const post = (path: string, body: unknown) =>
  get(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const isMocked = (value: unknown) => (value as { mocked?: boolean }).mocked === true

afterEach(() => {
  resetNetworkState()
  Object.assign(g, saved)
})

for (const kind of ['web', 'rn'] as const) {
  describe(`matching (${kind})`, () => {
    beforeEach(() => {
      g.XMLHttpRequest = kind === 'rn' ? class extends FakeRNXHR {} : class extends FakeXHR {}
      g.fetch = kind === 'rn' ? xhrFetch : nativeFetch
      tools = networkTools()
    })

    test('a string still matches any URL containing it', async () => {
      mockIt('/orders')
      expect(isMocked(await get('/orders/5/items'))).toBe(true)
    })

    test('path matches the whole path, on any host, ignoring the query', async () => {
      mockIt({ path: '/orders' })
      expect(isMocked(await get('/orders'))).toBe(true)
      expect(isMocked(await get('/orders?page=2'))).toBe(true)
      expect(isMocked(await get('/orders/5/items'))).toBe(false)
      expect(isMocked(await get('/v2/orders'))).toBe(false)
      expect(isMocked(await (await fetch('https://other.example/orders')).json())).toBe(true)
    })

    test('path takes :name for one segment and * for the rest', async () => {
      mockIt({ path: '/orders/:id/items' })
      mockIt({ path: '/files/*' }, { json: { mocked: true, file: true } })
      expect(isMocked(await get('/orders/5/items'))).toBe(true)
      expect(isMocked(await get('/orders/5'))).toBe(false)
      expect(isMocked(await get('/orders/5/6/items'))).toBe(false)
      expect(await get('/files/a/b.png')).toEqual({ mocked: true, file: true })
    })

    test('path edge cases: a colon inside a segment, trailing slash, root, encoding, spaces', async () => {
      mockIt({ path: '/v1/items:batchGet' })
      expect(isMocked(await get('/v1/items:batchGet'))).toBe(true)
      expect(isMocked(await get('/v1/items:other'))).toBe(false)
      mockIt({ path: '/slash/' })
      expect(isMocked(await get('/slash'))).toBe(true)
      expect(isMocked(await get('/slash/'))).toBe(true)
      mockIt({ path: '/cafés' })
      expect(isMocked(await get('/caf%C3%A9s'))).toBe(true)
      expect(() => mockIt({ path: '/my orders' })).toThrow('spaces')
      resetNetworkState()
      tools = networkTools()
      mockIt({ path: '/' })
      expect(isMocked(await (await fetch(API)).json())).toBe(true)
      expect(isMocked(await get('/'))).toBe(true)
    })

    test('path and method together', async () => {
      mockIt({ path: '/orders', method: 'post' })
      expect(isMocked(await get('/orders'))).toBe(false)
      expect(isMocked(await post('/orders', {}))).toBe(true)
    })

    test('body matches a JSON subset of the request body', async () => {
      mockIt({ path: '/search', body: { filter: { status: 'open' }, tags: ['a', 'b'] } })
      const hit = { q: 'x', filter: { status: 'open', owner: 1 }, tags: ['a', 'b'] }
      expect(isMocked(await post('/search', hit))).toBe(true)
      expect(isMocked(await post('/search', { ...hit, filter: { status: 'closed' } }))).toBe(false)
      expect(isMocked(await post('/search', { ...hit, tags: ['a'] }))).toBe(false)
      expect(isMocked(await post('/search', 'not json'))).toBe(false)
      expect(isMocked(await get('/search'))).toBe(false)
    })

    test('a body match reads a Request object body too', async () => {
      mockIt({ path: '/search', body: { q: 'x' } })
      const asked = new Request(`${API}/search`, { method: 'POST', body: JSON.stringify({ q: 'x' }) })
      expect(isMocked(await (await fetch(asked)).json())).toBe(true)
    })

    test('a body that does not match falls to the next mock, then the network; times is not spent', async () => {
      mockIt({ path: '/search', body: { q: 'x' } }, { json: { mocked: true } }, { times: 1 })
      mockIt({ path: '/search' }, { json: { fallback: true } }, { priority: -1 })
      expect(await post('/search', { q: 'y' })).toEqual({ fallback: true })
      expect(isMocked(await post('/search', { q: 'x' }))).toBe(true)
      expect(await post('/search', { q: 'x' })).toEqual({ fallback: true })
      run(tools, 'net.unmock')
      expect(await post('/search', { q: 'x' })).toEqual({ real: `${API}/search` })
    })

    test('graphql matches the operationName of a POST body or a GET query', async () => {
      mockIt({ graphql: 'GetUser' }, { json: { mocked: true } })
      mockIt({ graphql: 'ListPlants' }, { json: { plants: [] } })
      expect(isMocked(await post('/graphql', { operationName: 'GetUser', query: 'query GetUser {a}' }))).toBe(true)
      expect(await post('/graphql', { operationName: 'ListPlants', variables: {} })).toEqual({ plants: [] })
      expect(isMocked(await post('/graphql', { operationName: 'Other' }))).toBe(false)
      expect(isMocked(await get('/graphql?operationName=GetUser&query=x'))).toBe(true)
      expect(isMocked(await get('/graphql?operationName=Nope'))).toBe(false)
    })

    test('graphql with a path and a variables subset', async () => {
      mockIt({ graphql: 'GetUser', path: '/graphql', body: { variables: { id: '7' } } }, { json: { mocked: true, id: 7 } })
      expect(await post('/graphql', { operationName: 'GetUser', variables: { id: '7' } })).toEqual({ mocked: true, id: 7 })
      expect(isMocked(await post('/graphql', { operationName: 'GetUser', variables: { id: '8' } }))).toBe(false)
      expect(isMocked(await post('/other', { operationName: 'GetUser', variables: { id: '7' } }))).toBe(false)
    })

    test('strict mode blocks a request only body mocks matched by URL', async () => {
      mockIt({ path: '/search', body: { q: 'x' } })
      run(tools, 'net.strict', true)
      const res = await fetch(`${API}/search`, { method: 'POST', body: JSON.stringify({ q: 'y' }) })
      expect(res.status).toBe(501)
    })

    test('net.mockFromLog on a GraphQL request only answers that operation', async () => {
      await post('/graphql', { operationName: 'GetUser', query: 'q' })
      await tick()
      const id = (run(tools, 'net.log') as LogEntry[])[0]!.id
      const made = run(tools, 'net.mockFromLog', id, { real: 'patched' }) as { match: { graphql?: string } }
      expect(made.match.graphql).toBe('GetUser')
      expect(await post('/graphql', { operationName: 'GetUser', query: 'q' })).toEqual({ real: 'patched' })
      expect(await post('/graphql', { operationName: 'Other', query: 'q' })).toEqual({ real: `${API}/graphql` })
    })

    test('net.mockFromLog warns when a POST body was not kept, and reads the name from a long preview', async () => {
      await fetch(new Request(`${API}/graphql`, { method: 'POST', body: JSON.stringify({ operationName: 'GetUser' }) }))
      await tick()
      const unread = run(tools, 'net.mockFromLog', (run(tools, 'net.log') as LogEntry[])[0]!.id) as {
        match: { graphql?: string }
        warning?: string
      }
      expect(unread.match.graphql).toBeUndefined()
      expect(unread.warning).toContain('every request to that URL')

      await post('/graphql', { operationName: 'Big', query: 'x'.repeat(1_100_000) })
      await tick()
      const big = run(tools, 'net.mockFromLog', (run(tools, 'net.log') as LogEntry[])[0]!.id) as {
        match: { graphql?: string }
        warning?: string
      }
      expect(big.match.graphql).toBe('Big')
      expect(big.warning).toBeUndefined()

      await get('/plain')
      await tick()
      const plain = run(tools, 'net.mockFromLog', (run(tools, 'net.log') as LogEntry[])[0]!.id) as { warning?: string }
      expect(plain.warning).toBeUndefined()
    })

    test('an XHR aborted before send() is still sent', async () => {
      const xhr = new globalThis.XMLHttpRequest()
      const done = new Promise<void>((resolve) => {
        xhr.onloadend = () => resolve()
      })
      xhr.open('GET', `${API}/early-abort`)
      xhr.abort()
      xhr.send(null)
      await Promise.race([done, tick(200).then(() => Promise.reject(new Error('never finished')))])
      expect(server.hits).toContain(`GET ${API}/early-abort`)
    })

    test('a binary Request body is not read for a body mock, nor logged', async () => {
      mockIt({ body: { a: 1 } })
      const binary = new Request(`${API}/upload`, {
        method: 'PUT',
        body: new Uint8Array([1, 2, 3]),
        headers: { 'content-type': 'application/octet-stream' },
      })
      let reads = 0
      const clone = binary.clone.bind(binary)
      binary.clone = () => {
        reads += 1
        return clone()
      }
      expect(isMocked(await (await fetch(binary)).json())).toBe(false)
      await tick()
      expect(reads).toBe(0)
      expect((run(tools, 'net.log') as LogEntry[])[0]!.requestBody).toBeUndefined()
    })

    test('strict mode names the operation of a fetch(Request) whose body was read for a mock', async () => {
      mockIt({ graphql: 'Other' })
      run(tools, 'net.strict', true)
      await fetch(new Request(`${API}/graphql`, { method: 'POST', body: JSON.stringify({ operationName: 'GetUser' }) }))
      const { blocked } = run(tools, 'net.strict') as { blocked: Array<{ operation?: string }> }
      expect(blocked.map((b) => b.operation)).toEqual(['GetUser'])
    })

    test('strict mode only blames mocks whose body did not match', async () => {
      mock({ path: '/h', body: { a: 1 } }, () => undefined)
      const wrong = mockIt({ path: '/h', body: { a: 2 } })
      run(tools, 'net.strict', true)
      const errors = spyOn(console, 'error').mockImplementation(() => {})
      const res = await fetch(`${API}/h`, { method: 'POST', body: JSON.stringify({ a: 1 }) })
      const message = ((await res.json()) as { error: string }).error
      errors.mockRestore()
      expect(message).toContain('no mock for')
      expect(message).toContain(`(${wrong.id} matched`)
    })

    test('a handler mock with times: 1 answers one of two requests in flight', async () => {
      mock({ path: '/h1' }, async () => {
        await tick(20)
        return { json: { mocked: true } }
      }, { times: 1 })
      const both = await Promise.all([get('/h1'), get('/h1')])
      expect(both.filter(isMocked)).toHaveLength(1)
    })

    test('times is not over-spent by two requests at once', async () => {
      mockIt({ path: '/once', body: { a: 1 } }, { json: { mocked: true } }, { times: 1 })
      const asked = () => new Request(`${API}/once`, { method: 'POST', body: JSON.stringify({ a: 1 }) })
      const both = await Promise.all([fetch(asked()), fetch(asked())].map(async (r) => (await r).json()))
      expect(both.filter(isMocked)).toHaveLength(1)
    })

    test('strict mode names the GraphQL operation it blocked', async () => {
      run(tools, 'net.strict', true)
      await post('/graphql', { operationName: 'GetUser' })
      await post('/graphql', { operationName: 'GetPlants' })
      const { blocked } = run(tools, 'net.strict') as { blocked: Array<{ operation?: string }> }
      expect(blocked.map((b) => b.operation).sort()).toEqual(['GetPlants', 'GetUser'])
    })

    test('a match needs url, path, body or graphql; bad values are refused', () => {
      expect(() => mockIt({ method: 'POST' })).toThrow('match')
      expect(() => mockIt({ path: 'orders' })).toThrow('path')
      expect(() => mockIt({ path: 'https://x.example/orders' })).toThrow('path')
      expect(() => mockIt({ graphql: 5 })).toThrow('graphql')
      expect(() => mockIt({ body: 'x' })).toThrow('body')
      expect(() => mockIt({ body: { a: undefined } })).toThrow('body')
    })

    test('net.mock and net.mocks say what a mock matches', () => {
      expect(mockIt('/orders').matches).toBe('any method, URL containing "/orders"')
      const r = mockIt({ path: '/orders/:id', method: 'post', body: { a: 1 } })
      expect(r.matches).toBe('POST, path /orders/:id (whole path, any host), JSON body containing {"a":1}')
      expect(mockIt({ graphql: 'GetUser' }).matches).toBe('any method, GraphQL operation "GetUser"')
      const listed = run(tools, 'net.mocks') as Array<{ id: string; matches: string }>
      expect(listed.find((m) => m.id === r.id)?.matches).toBe(r.matches)
    })

    test('shadows: a new mock with times is not certain to shadow', () => {
      const first = mockIt('/limited')
      expect(mockIt('/limited', { json: {} }, { times: 1 }).shadows).toBeUndefined()
      expect(mockIt('/limited').shadows).toContain(first.id)
    })

    test('shadows: a plain mock covers narrower ones, a narrow one covers nothing', () => {
      const gql = mockIt({ graphql: 'GetUser' })
      const body = mockIt({ url: '/search', body: { q: 'x' } })
      const path = mockIt({ path: '/search' })
      expect(mockIt({ url: '/search', body: { q: 'y' } }).shadows).toBeUndefined()
      expect(mockIt({ graphql: 'Other' }).shadows).toBeUndefined()
      const plain = mockIt('/search')
      expect(plain.shadows).toContain(body.id)
      expect(plain.shadows).not.toContain(gql.id)
      expect(plain.shadows).not.toContain(path.id)
    })
  })
}

describe('net.waitFor', () => {
  beforeEach(() => {
    g.XMLHttpRequest = class extends FakeXHR {}
    g.fetch = nativeFetch
    tools = networkTools()
  })

  const waitFor = (match: unknown, options?: object) => run(tools, 'net.waitFor', match, options) as Promise<LogEntry>

  test('returns the entry of a request that already finished', async () => {
    await post('/orders', { id: 1 })
    const entry = await waitFor({ path: '/orders' })
    expect(entry.status).toBe(200)
    expect(entry.method).toBe('POST')
  })

  test('waits for a later request to finish', async () => {
    server.handle = () => ({ status: 201, body: '{}' })
    const waiting = waitFor('/slow', { timeoutMs: 1000 })
    await tick(20)
    await get('/slow/1')
    expect((await waiting).status).toBe(201)
  })

  test('matches on the request body and a graphql operation', async () => {
    await post('/graphql', { operationName: 'A' })
    await post('/graphql', { operationName: 'B', variables: { id: 2 } })
    expect(((await waitFor({ graphql: 'A' })).requestBody ?? '')).toContain('"A"')
    expect((await waitFor({ body: { variables: { id: 2 } } })).requestBody).toContain('"B"')
  })

  test('status narrows it, sinceId skips older requests', async () => {
    server.handle = (_m, url) => ({ status: url.endsWith('/bad') ? 500 : 200, body: '{}' })
    await get('/a/ok')
    await get('/a/bad')
    expect((await waitFor('/a/', { status: 500 })).url).toBe(`${API}/a/bad`)
    const last = (run(tools, 'net.log') as LogEntry[])[0]!.id
    await expect(waitFor('/a/', { sinceId: last, timeoutMs: 60 })).rejects.toThrow('Timed out')
  })

  test('a pending request does not count until it finishes', async () => {
    run(tools, 'net.mock', '/lag', { json: {} }, { delayMs: 80 })
    const pending = get('/lag')
    await tick(10)
    const entry = await waitFor('/lag', { timeoutMs: 1000 })
    expect(entry.pending).toBeUndefined()
    await pending
  })

  test('a GET with ?operationName= matches a graphql wait', async () => {
    await get('/graphql?operationName=GetUser&variables=%7B%7D')
    expect((await waitFor({ graphql: 'GetUser' }, { timeoutMs: 200 })).url).toContain('operationName=GetUser')
  })

  test('waits for the response body to be read, not just the headers', async () => {
    resetNetworkState()
    g.fetch = async () =>
      ({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        clone: () => ({ text: () => new Promise<string>((r) => setTimeout(() => r('{"late":true}'), 60)) }),
      }) as unknown as Response
    tools = networkTools()
    void fetch(`${API}/slowbody`)
    const entry = await waitFor('/slowbody', { timeoutMs: 1000 })
    expect(entry.responseBody).toBe('{"late":true}')
    expect(entry.truncated).toBeUndefined()
  })

  test('times out with what it looked for', async () => {
    await expect(waitFor({ path: '/never' }, { timeoutMs: 40 })).rejects.toThrow('Timed out after 40 ms waiting for')
  })

  test('refuses a bad match or timeout', () => {
    expect(() => waitFor({ method: 'GET' })).toThrow('match')
    expect(() => waitFor('/x', { timeoutMs: -1 })).toThrow('timeoutMs')
  })
})
