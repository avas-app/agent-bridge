import { expect, mock, test } from 'bun:test'

import type { CallMessage, DeviceInfo, ResultMessage } from '../../shared/protocol'

test('replies with a failed result when dispatch rejects', async () => {
  const listeners = new Map<string, (payload: unknown) => unknown>()
  const sent: Array<[string, unknown]> = []
  mock.module('expo/devtools', () => ({
    getDevToolsPluginClientAsync: async () => ({
      addMessageListener: (event: string, listener: (payload: unknown) => unknown) => {
        listeners.set(event, listener)
        return { remove: () => listeners.delete(event) }
      },
      sendMessage: (event: string, payload: unknown) => {
        sent.push([event, payload])
      },
      closeAsync: async () => {},
    }),
  }))
  const { expoTransport } = await import('../index')

  const info: DeviceInfo = {
    deviceId: 'dev',
    name: 'test',
    platform: 'ios',
    protocol: 1,
    tools: [],
  }
  expoTransport().start({
    info: () => info,
    dispatch: () => Promise.reject(new Error('kaboom')),
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const onCall = listeners.get('call') as (call: CallMessage) => Promise<void>
  await onCall({ id: 'call-9', tool: 'bridge.ping' })

  const result = sent.find(([event]) => event === 'result')?.[1] as ResultMessage
  expect(result).toMatchObject({ id: 'call-9', from: 'dev', ok: false, error: 'kaboom' })
})
