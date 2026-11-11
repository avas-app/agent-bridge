import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { mock, networkTools } from '../index'
import { resetNetworkState, setDeviceOffline } from '../state'
import { FakeRNXHR, nativeFetch, sendXhr, server, xhrFetch } from './fakes'

const g = globalThis as unknown as Record<string, unknown>
const saved = { fetch: g.fetch, XMLHttpRequest: g.XMLHttpRequest }

afterEach(() => {
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
