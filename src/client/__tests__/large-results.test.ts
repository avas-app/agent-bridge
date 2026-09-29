import { afterEach, describe, expect, test } from 'bun:test'

import WebSocket from 'ws'

import { cdpTransport } from '../../runtime/cdp-transport'
import { createRegistry } from '../../runtime/registry'
import type { Tools } from '../../runtime/types'
import {
  type CallMessage,
  type DeviceInfo,
  PLUGIN_NAME,
  PROTOCOL_VERSION,
} from '../../shared/protocol'
import { connect } from '../index'
import { bigValue } from './big-value'
import { startFakeMetro } from './fake-metro'

const sizes = { '200 KB': 200_000, '2 MB': 2_000_000 }

const tools: Tools = {
  'demo.big': (bytes: number) => bigValue(bytes),
}

function appContext(deviceId: string) {
  const registry = createRegistry(() => tools)
  const info = (): DeviceInfo => ({
    deviceId,
    name: 'Fake Phone',
    platform: 'ios',
    protocol: PROTOCOL_VERSION,
    tools: registry.list(),
  })
  return {
    info,
    dispatch: (call: CallMessage) => registry.dispatch(call, deviceId),
  }
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

describe.each(Object.entries(sizes))('a %s result', (_label, bytes) => {
  test('arrives whole over CDP', async () => {
    const metro = await startFakeMetro({
      acceptOrigin: (port) => `http://localhost:${port}`,
    })
    cleanups.push(metro.close, cdpTransport().start(appContext('dev-cdp')))
    const bridge = await connect({
      metro: metro.metro,
      transport: 'cdp',
      timeoutMs: 30_000,
    })
    cleanups.push(bridge.close)
    expect(await bridge.call('demo.big', bytes)).toEqual(bigValue(bytes))
  })

  test('arrives whole over Expo', async () => {
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    const context = appContext('dev-expo')
    const ws = new WebSocket(`ws://${metro.metro}/expo-dev-plugins/broadcast`)
    await new Promise((r) => ws.once('open', r))
    cleanups.push(() => ws.close())
    const send = (method: string, payload: unknown) =>
      ws.send(
        JSON.stringify({
          messageKey: { pluginName: PLUGIN_NAME, method },
          payload,
        }),
      )
    ws.on('message', async (data) => {
      const { messageKey, payload } = JSON.parse(String(data))
      if (messageKey.pluginName !== PLUGIN_NAME) return
      if (messageKey.method === 'hello') send('hello:reply', context.info())
      if (messageKey.method === 'call')
        send('result', await context.dispatch(payload))
    })
    const bridge = await connect({
      metro: metro.metro,
      transport: 'expo',
      timeoutMs: 30_000,
    })
    cleanups.push(bridge.close)
    expect(await bridge.call('demo.big', bytes)).toEqual(bigValue(bytes))
  })
})
