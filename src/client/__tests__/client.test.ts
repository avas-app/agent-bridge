import { afterEach, describe, expect, test } from 'bun:test'

import WebSocket from 'ws'

import { cdpTransport } from '../../runtime/cdp-transport'
import { createLogCapture } from '../../runtime/logs'
import { createRegistry } from '../../runtime/registry'
import type { Tools } from '../../runtime/types'
import {
  type CallMessage,
  type DeviceInfo,
  PLUGIN_NAME,
  PROTOCOL_VERSION,
} from '../../shared/protocol'
import { AgentBridgeCallError, connect } from '../index'
import { startFakeMetro } from './fake-metro'

const tools: Tools = {
  'demo.echo': (...args: unknown[]) => args,
  'demo.later': async (ms: number) => {
    await new Promise((r) => setTimeout(r, ms))
    return 'done'
  },
  'demo.fail': () => {
    throw new Error('it broke')
  },
}

function appContext(name: string, deviceId: string) {
  const registry = createRegistry(() => tools)
  const info = (): DeviceInfo => ({
    deviceId,
    name,
    platform: 'ios',
    protocol: PROTOCOL_VERSION,
    tools: registry.list(),
  })
  return {
    info,
    dispatch: (call: CallMessage) => registry.dispatch(call, deviceId),
  }
}

/** An app connected to Expo's broadcast socket, answering like expoTransport. */
async function fakeExpoApp(metro: string, name: string, deviceId: string) {
  const context = appContext(name, deviceId)
  const ws = new WebSocket(`ws://${metro}/expo-dev-plugins/broadcast`)
  await new Promise((r) => ws.once('open', r))
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
    if (
      messageKey.method === 'call' &&
      (!payload.to || payload.to === deviceId)
    ) {
      send('result', await context.dispatch(payload))
    }
  })
  return ws
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

describe('CDP transport', () => {
  test('calls tools, including async ones and non-ASCII payloads', async () => {
    const metro = await startFakeMetro({
      hostUri: (port) => `fakehost:${port}`,
      acceptOrigin: (port) => `http://fakehost:${port}`,
    })
    cleanups.push(
      metro.close,
      cdpTransport().start(appContext('Fake Phone', 'dev-cdp')),
    )

    const bridge = await connect({ metro: metro.metro, transport: 'cdp' })
    cleanups.push(bridge.close)
    expect(bridge.transport).toBe('cdp')

    const car = String.fromCodePoint(0x1f697)
    expect(await bridge.call('demo.echo', `Ride ${car}`, { n: 1 })).toEqual([
      `Ride ${car}`,
      { n: 1 },
    ])
    expect(await bridge.call('demo.later', 20)).toBe('done')
    await expect(bridge.call('demo.fail')).rejects.toBeInstanceOf(
      AgentBridgeCallError,
    )
  })

  test('timed returns the errors the reply carried, escaped for Hermes', async () => {
    const metro = await startFakeMetro({
      acceptOrigin: (port) => `http://localhost:${port}`,
    })
    const capture = createLogCapture()
    const registry = createRegistry(
      () => ({
        'app.logError': (message: string) =>
          capture.record('error', [message]),
        'app.fail': () => {
          capture.record('error', ['before failing'])
          throw new Error('failed')
        },
      }),
      capture,
    )
    const context = appContext('Fake Phone', 'dev-cdp')
    cleanups.push(
      metro.close,
      cdpTransport().start({
        info: context.info,
        dispatch: (call) => registry.dispatch(call, 'dev-cdp'),
      }),
    )
    const bridge = await connect({ metro: metro.metro, transport: 'cdp' })
    cleanups.push(bridge.close)

    const car = String.fromCodePoint(0x1f697)
    const { logs } = await bridge.timed('app.logError', `no ${car}`)
    expect(logs).toMatchObject([
      { level: 'error', message: `no ${car}`, during: 'app.logError' },
    ])
    const failure = await bridge.call('app.fail').catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(AgentBridgeCallError)
    expect((failure as AgentBridgeCallError).logs).toMatchObject([
      { message: 'before failing' },
    ])
  })

  test('explains a dropped socket in terms of the Origin it sent', async () => {
    const metro = await startFakeMetro({
      hostUri: (port) => `fakehost:${port}`,
      acceptOrigin: () => 'http://somewhere-else:1',
    })
    cleanups.push(
      metro.close,
      cdpTransport().start(appContext('Fake Phone', 'dev-cdp')),
    )
    await expect(
      connect({ metro: metro.metro, transport: 'cdp' }),
    ).rejects.toThrow('Origin sent: http://fakehost:')
  })

  test('says so when the debugger cannot run code, instead of blaming the app', async () => {
    const metro = await startFakeMetro({
      acceptOrigin: (port) => `http://localhost:${port}`,
      noEvaluate: true,
    })
    cleanups.push(
      metro.close,
      cdpTransport().start(appContext('Fake Phone', 'dev-cdp')),
    )
    const failure = connect({ metro: metro.metro, transport: 'cdp' })
    await expect(failure).rejects.toThrow("can't run code")
    await expect(failure).rejects.toThrow('--transport expo')
  })

  test('auto falls back to CDP when Metro has no Expo socket', async () => {
    const metro = await startFakeMetro({
      acceptOrigin: (port) => `http://localhost:${port}`,
    })
    cleanups.push(
      metro.close,
      cdpTransport().start(appContext('Fake Phone', 'dev-cdp')),
    )
    const bridge = await connect({ metro: metro.metro })
    cleanups.push(bridge.close)
    expect(bridge.transport).toBe('cdp')
    expect(await bridge.call('demo.echo', 1)).toEqual([1])
  })
})

describe('Expo transport', () => {
  test('addresses one device when several share the socket', async () => {
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    const a = await fakeExpoApp(metro.metro, 'Phone A', 'dev-a')
    const b = await fakeExpoApp(metro.metro, 'Phone B', 'dev-b')
    cleanups.push(
      () => a.close(),
      () => b.close(),
    )

    await expect(
      connect({ metro: metro.metro, transport: 'expo' }),
    ).rejects.toThrow('2 apps are connected')

    const bridge = await connect({
      metro: metro.metro,
      transport: 'expo',
      device: 'Phone B',
    })
    cleanups.push(bridge.close)
    expect(bridge.device.deviceId).toBe('dev-b')
    const { value, appMs, logs } = await bridge.timed('demo.echo', 'hi')
    expect(value).toEqual(['hi'])
    expect(logs).toEqual([])
    expect(appMs).toBeGreaterThanOrEqual(0)
    await expect(bridge.call('demo.fail')).rejects.toThrow(
      'demo.fail: it broke',
    )
  })
})
