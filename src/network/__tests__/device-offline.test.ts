import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { deviceTools } from '../../adapters/device'
import type { ToolFn, Tools } from '../../runtime/types'
import { mock, networkTools } from '../index'
import { resetNetworkState, setDeviceOffline } from '../state'
import { FakeRNXHR, nativeFetch, sendXhr, server, xhrFetch } from './fakes'

const g = globalThis as unknown as Record<string, unknown>
const saved = { fetch: g.fetch, XMLHttpRequest: g.XMLHttpRequest }
const savedHandle = server.handle

afterEach(() => {
  server.handle = savedHandle
  resetNetworkState()
  Object.assign(g, saved)
})

for (const kind of ['web', 'rn'] as const) {
  describe(`device offline (${kind})`, () => {
    beforeEach(() => {
      server.handle = () => ({ status: 200, body: '{}' })
      server.hits = []
      g.XMLHttpRequest = class extends FakeRNXHR {}
      g.fetch = kind === 'rn' ? xhrFetch : nativeFetch
      networkTools()
    })

    test('fails fetch even where a mock would answer, and comes back', async () => {
      mock('/plants', { json: ['fern'] })
      setDeviceOffline(true)
      await expect(fetch('https://api.example/plants')).rejects.toThrow('Network request failed')
      await expect(fetch('https://api.example/other')).rejects.toThrow('Network request failed')
      expect(server.hits).toEqual([])

      setDeviceOffline(false)
      expect(await (await fetch('https://api.example/plants')).json()).toEqual(['fern'])
    })

    test('fails XHR too', async () => {
      setDeviceOffline(true)
      const xhr = await sendXhr('GET', 'https://api.example/x')
      expect(xhr.status).toBe(0)
    })
  })
}

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

describe('device.offline on its own', () => {
  afterEach(() => {
    run(deviceTools(), 'device.restore')
  })

  beforeEach(() => {
    server.handle = () => ({ status: 200, body: '{}' })
    server.hits = []
    g.XMLHttpRequest = class extends FakeRNXHR {}
    g.fetch = nativeFetch
  })

  test('fails a real fetch without networkTools() or a mock', async () => {
    const tools = deviceTools()
    run(tools, 'device.offline', true)
    await expect(fetch('https://api.example/x')).rejects.toThrow('Network request failed')
    expect(server.hits).toEqual([])
    run(tools, 'device.restore')
    expect((await fetch('https://api.example/x')).status).toBe(200)
  })

  test('logs the failure as device offline, not as a strict-mode block', async () => {
    const tools = deviceTools()
    const net = networkTools()
    run(tools, 'device.offline', true)
    await expect(fetch('https://api.example/x')).rejects.toThrow()
    await sendXhr('GET', 'https://api.example/y')
    const log = run(net, 'net.log') as Array<{ error?: string; blocked?: boolean }>
    expect(log).toHaveLength(2)
    for (const entry of log) {
      expect(entry.error).toBe('Network request failed (device offline)')
      expect(entry.blocked).toBeUndefined()
    }
    expect(run(net, 'net.strict')).toMatchObject({ blocked: [] })
  })

  test('still fails with mocks that match on the body', async () => {
    const tools = deviceTools()
    mock({ url: '/q', body: { a: 1 } }, { json: { ok: true } })
    run(tools, 'device.offline', true)
    await expect(
      fetch('https://api.example/q', { method: 'POST', body: JSON.stringify({ a: 1 }) }),
    ).rejects.toThrow('Network request failed')
  })
})
