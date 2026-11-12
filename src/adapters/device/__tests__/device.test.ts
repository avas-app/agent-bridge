import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'

import { networkState, resetNetworkState } from '../../../network/state'
import type { ToolFn, Tools } from '../../../runtime/types'
import { deviceTools } from '../../device'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}
const pending = (tools: Tools) => {
  const t = tools['device.restore']
  return typeof t === 'function' ? undefined : t!.pending!()
}

// RN's emitter, with AppState's own listener the way AppState.js sets it up.
function fakeRN() {
  const bus = new EventEmitter()
  const DeviceEventEmitter = {
    emit: (e: string, p: unknown) => bus.emit(e, p),
    addListener: (e: string, l: (p: unknown) => void) => bus.on(e, l),
    listenerCount: (e: string) => bus.listenerCount(e),
  }
  const AppState = { currentState: 'active' }
  bus.on('appStateDidChange', (p: { app_state: string }) => {
    AppState.currentState = p.app_state
  })
  const getInitialURL = () => Promise.resolve('real://start')
  return { bus, DeviceEventEmitter, AppState, Linking: { getInitialURL } }
}

let rn: ReturnType<typeof fakeRN>
let tools: Tools
const RealDate = globalThis.Date
beforeEach(() => {
  rn = fakeRN()
  tools = deviceTools({ reactNative: rn as never, time: true, Notifications: {} })
})
afterEach(() => {
  run(tools, 'device.restore')
  resetNetworkState()
  globalThis.Date = RealDate
})

describe('device.openUrl', () => {
  test('reaches listeners added before and after, and getInitialURL follows until restore', async () => {
    const early = mock()
    rn.DeviceEventEmitter.addListener('url', early)
    const orig = rn.Linking.getInitialURL
    expect(await run(tools, 'device.openUrl', 'myapp://orders/5')).toEqual({ url: 'myapp://orders/5', listeners: 1 })
    expect(early).toHaveBeenCalledWith({ url: 'myapp://orders/5' })
    expect(await rn.Linking.getInitialURL()).toBe('myapp://orders/5')
    expect(pending(tools)).toEqual({ initialUrl: 'myapp://orders/5' })

    run(tools, 'device.restore')
    expect(rn.Linking.getInitialURL).toBe(orig)
    expect(pending(tools)).toBe(false)
  })

  test('returns the route once a navigation container is passed', async () => {
    const navigation = {
      getRootState: () => ({ index: 0, routes: [{ name: '__root', state: { index: 0, routes: [{ name: 'orders' }] } }] }),
      addListener: (_: string, cb: () => void) => {
        rn.bus.on('url', cb)
        return () => rn.bus.off('url', cb)
      },
    }
    const t = deviceTools({ reactNative: rn as never, navigation })
    const result = (await run(t, 'device.openUrl', 'myapp://orders')) as { route: { pathname: string } }
    expect(result.route.pathname).toBe('/orders')
    run(t, 'device.restore')
  })

  test('rejects a missing url', () => {
    expect(() => run(tools, 'device.openUrl')).toThrow('Pass the URL')
  })
})

describe('device.appState', () => {
  test('fires listeners, reports currentState, and restore goes back', () => {
    const seen: string[] = []
    rn.DeviceEventEmitter.addListener('appStateDidChange', (p) => seen.push((p as { app_state: string }).app_state))

    expect(run(tools, 'device.appState', 'background')).toEqual({ state: 'background', previous: 'active' })
    expect(rn.AppState.currentState).toBe('background')
    expect(pending(tools)).toEqual({ state: 'background', real: 'active' })

    run(tools, 'device.appState', 'inactive')
    expect(rn.AppState.currentState).toBe('inactive')

    run(tools, 'device.restore')
    expect(rn.AppState.currentState).toBe('active')
    expect(seen).toEqual(['background', 'inactive', 'active'])
    expect(pending(tools)).toBe(false)
  })

  test('a real change while faked is what restore returns to', () => {
    run(tools, 'device.appState', 'background')
    rn.AppState.currentState = 'inactive'
    expect(rn.AppState.currentState).toBe('background')
    run(tools, 'device.restore')
    expect(rn.AppState.currentState).toBe('inactive')
  })

  test('rejects an unknown state', () => {
    expect(() => run(tools, 'device.appState', 'sleeping')).toThrow('active, background, inactive')
  })
})

describe('device.offline', () => {
  test('flips the network, tells NetInfo, and restore refreshes it', async () => {
    const states: unknown[] = []
    rn.DeviceEventEmitter.addListener('netInfo.networkStatusDidChange', (s) => states.push(s))
    const refresh = mock(() => Promise.resolve({}))
    const NetInfo = { refresh }
    const t = deviceTools({ reactNative: rn as never, NetInfo })

    expect(run(t, 'device.offline', true)).toEqual({ offline: true })
    expect(networkState().deviceOffline).toBe(true)
    expect(states[0]).toMatchObject({ type: 'none', isConnected: false })
    await NetInfo.refresh()
    expect(refresh).not.toHaveBeenCalled()
    expect(pending(t)).toEqual({ offline: true, netInfo: true })

    run(t, 'device.restore')
    expect(networkState().deviceOffline).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(pending(t)).toBe(false)
  })

  test('offline false and turning it on twice are safe', () => {
    run(tools, 'device.offline', true)
    run(tools, 'device.offline', true)
    expect(run(tools, 'device.offline', false)).toEqual({ offline: false })
    expect(networkState().deviceOffline).toBe(false)
    expect(() => run(tools, 'device.offline', 'yes')).toThrow('true or false')
  })
})

describe('device.notification', () => {
  test('delivers received, or a tapped response with the default action', () => {
    const received = mock()
    const response = mock()
    rn.DeviceEventEmitter.addListener('onDidReceiveNotification', received)
    rn.DeviceEventEmitter.addListener('onDidReceiveNotificationResponse', response)

    run(tools, 'device.notification', { title: 'Hi', body: 'There', data: { orderId: 5 } })
    expect(received.mock.calls[0]![0]).toMatchObject({
      request: { content: { title: 'Hi', body: 'There', data: { orderId: 5 } } },
    })
    expect(run(tools, 'device.notification', { title: 'Tap' }, { tapped: true })).toMatchObject({ event: 'response' })
    expect(response.mock.calls[0]![0]).toMatchObject({
      actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
      notification: { request: { content: { title: 'Tap' } } },
    })
  })

  test('is left out when the app passes no Notifications', () => {
    expect(deviceTools({ reactNative: rn as never })['device.notification']).toBeUndefined()
  })
})

describe('device.setTime', () => {
  test('shifts Date.now and new Date, keeps Date working, and restores the real one', () => {
    const real = Date.now()
    const result = run(tools, 'device.setTime', '2030-01-02T03:04:05Z') as { now: string }
    expect(result.now.startsWith('2030-01-02T03:04')).toBe(true)
    expect(new Date().getUTCFullYear()).toBe(2030)
    expect(Math.abs(Date.now() - Date.parse('2030-01-02T03:04:05Z'))).toBeLessThan(1000)
    expect(new Date('2020-01-01T00:00:00Z').getUTCFullYear()).toBe(2020)
    expect(new Date() instanceof RealDate).toBe(true)
    expect(Date.UTC(2020, 0, 1)).toBe(RealDate.UTC(2020, 0, 1))
    expect(typeof Date()).toBe('string')
    expect(pending(tools)).toMatchObject({ offsetMs: expect.any(Number) })

    run(tools, 'device.setTime', { offsetMs: 1000 })
    expect(Date.now() - real).toBeGreaterThanOrEqual(1000)
    expect(Date.now() - real).toBeLessThan(2000)

    run(tools, 'device.restore')
    expect(globalThis.Date).toBe(RealDate)
    expect(pending(tools)).toBe(false)
  })

  test('is off unless time: true, and rejects junk', () => {
    expect(deviceTools({ reactNative: rn as never })['device.setTime']).toBeUndefined()
    expect(() => run(tools, 'device.setTime', 'soon')).toThrow('ISO date')
  })
})

describe('review fixes', () => {
  const expoModules = () => (globalThis as { expo?: unknown }).expo
  afterEach(() => {
    delete (globalThis as { expo?: unknown }).expo
  })

  test('restore from a rebuilt tools object still un-fakes NetInfo', async () => {
    const refresh = mock(() => Promise.resolve({}))
    const NetInfo = { refresh }
    const first = deviceTools({ reactNative: rn as never, NetInfo })
    run(first, 'device.offline', true)
    const second = deviceTools({ reactNative: rn as never, NetInfo })
    run(second, 'device.restore')
    expect(NetInfo.refresh).toBe(refresh)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('restore reports restored: true when any area undid something, with each area\'s detail', async () => {
    await run(tools, 'device.openUrl', 'myapp://a')
    run(tools, 'device.appState', 'background')
    expect(run(tools, 'device.restore')).toEqual({ restored: true, url: 'myapp://a', state: 'active' })
  })

  test('openUrl also reaches expo-linking through its native emitter', async () => {
    const emit = mock()
    ;(globalThis as { expo?: unknown }).expo = { modules: { ExpoLinking: { emit } } }
    await run(tools, 'device.openUrl', 'myapp://x')
    expect(emit).toHaveBeenCalledWith('onURLReceived', { url: 'myapp://x' })
    expect(expoModules()).toBeDefined()
  })

  test('the faked Date keeps x.constructor === Date, and restore puts the real one back', () => {
    run(tools, 'device.setTime', { offsetMs: 1000 })
    expect(new Date(0).constructor === Date).toBe(true)
    expect(new Date().constructor === Date).toBe(true)
    run(tools, 'device.restore')
    expect(new Date(0).constructor).toBe(RealDate)
  })

  test('notification says which emitter it used and how many listeners heard it', () => {
    expect(run(tools, 'device.notification', { title: 'Hi' })).toMatchObject({
      via: 'DeviceEventEmitter',
      listeners: 0,
    })
    rn.DeviceEventEmitter.addListener('onDidReceiveNotification', () => {})
    expect(run(tools, 'device.notification', { title: 'Hi' })).toMatchObject({ listeners: 1 })
    const native = new EventEmitter()
    ;(globalThis as { expo?: unknown }).expo = {
      modules: { ExpoNotificationsEmitter: { emit: (e: string, p: unknown) => native.emit(e, p), listenerCount: (e: string) => native.listenerCount(e) } },
    }
    native.on('onDidReceiveNotificationResponse', () => {})
    expect(run(tools, 'device.notification', { title: 'T' }, { tapped: true })).toMatchObject({
      via: 'ExpoNotificationsEmitter',
      listeners: 1,
      event: 'response',
    })
  })

  test('the emitting flag is shared by two tools objects', () => {
    const other = deviceTools({ reactNative: rn as never })
    run(tools, 'device.appState', 'background')
    run(other, 'device.appState', 'inactive')
    rn.AppState.currentState = 'active' // a real change arrives
    expect(rn.AppState.currentState).toBe('inactive')
    run(other, 'device.restore')
    expect(rn.AppState.currentState).toBe('active')
  })
})

test('restore with nothing changed is a no-op', () => {
  expect(run(tools, 'device.restore')).toMatchObject({ restored: false })
})
