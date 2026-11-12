import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import WebSocket from 'ws'
import { createStore } from 'zustand/vanilla'

import { mmkvTools } from '../../../adapters/react-native-mmkv'
import { storeTools } from '../../../adapters/zustand'
import { restoreTools } from '../../../runtime/tools/restore'
import { createLogCapture } from '../../../runtime/logs'
import { createRegistry } from '../../../runtime/registry'
import { bridgeTools } from '../../../runtime/tools/bridge'
import type { Tools } from '../../../runtime/types'
import {
  type DeviceInfo,
  PLUGIN_NAME,
  PROTOCOL_VERSION,
} from '../../../shared/protocol'
import { startFakeMetro } from '../../__tests__/fake-metro'
import { bigValue } from '../../__tests__/big-value'
import { AgentBridgeCallError } from '../../index'
import { sessionFor } from '../cli'
import { connectSession, sessionRequest } from '../client'
import { sessionCommand } from '../cli'
import { runSessionDaemon } from '../daemon'
import {
  isAlive,
  listSessions,
  parseDuration,
  projectRoot,
  sessionFiles,
  writePrivate,
} from '../state'

/** An app on Expo's broadcast socket. `restores` counts bridge.restore calls. */
async function fakeApp(
  metro: string,
  firstId: string,
  options: {
    restore?: boolean
    /** Bundle load id; the same one means Fast Refresh, not a reload. */
    loadId?: string
    /** Close the socket on app.reload instead of answering it. */
    dropReload?: boolean
    /** Leave out bridge.pending, as an older app would. */
    pending?: boolean
    /** The name the app gives the bridge. Default "Fake App". */
    name?: string
    /** Extra tools, rebuilt (so their in-memory undo state is gone) on every reload. */
    extra?: (getTools: () => Tools) => Tools
    /** Announce no load id, as an older app package does. */
    noLoadId?: boolean
    /** Tools that run, then drop the socket before replying, the first time only. */
    dropOnce?: string[]
    /** Tools that just count their runs and answer "ran". */
    counted?: string[]
  } = {},
) {
  let deviceId = firstId
  let loadId = options.loadId ?? 'load-1'
  const logs = createLogCapture()
  const app = {
    logs,
    restores: 0,
    drops: 0,
    slow: 0,
    reloads: 0,
    /** How many times each dropOnce tool ran. */
    runs: {} as Record<string, number>,
    changed: false,
    /** Called for every call this app receives. */
    onCall: undefined as ((tool: string, args: unknown[]) => void) | undefined,
    ws: undefined as unknown as WebSocket,
    /** The runtime restarts on this socket. A new device id is announced, as Expo does. */
    reload: (id: string, load = loadId) => {
      const announce = id !== deviceId
      deviceId = id
      loadId = load
      extra = options.extra?.(getAll) ?? {}
      registry = make()
      if (announce) send('hello:reply', info())
    },
  }
  const tools: Tools = {
    'demo.echo': (...args: unknown[]) => args,
    // A read-only name, so a lost reply is run again.
    'store.get': (...args: unknown[]) => args,
    'demo.big': (bytes: number) => bigValue(bytes),
    'demo.boom': () => {
      logs.record('error', ['boom'])
    },
    // Runs, then the socket drops before the reply: the app reloaded mid-call.
    'demo.drop': () => {
      app.drops++
      app.ws.close()
    },
    'mmkv.get': () => {
      app.drops++
      if (!getDropped) {
        getDropped = true
        app.ws.close()
      }
      return 'got'
    },
    'demo.set': () => {
      app.changed = true
    },
    ...(options.pending === false
      ? {}
      : {
          'bridge.pending': () =>
            app.changed ? { demo: { key: { snapshot: 1, current: 2 } } } : {},
        }),
    'demo.restore': {
      pending: () => app.changed,
      run: () => {
        app.changed = false
      },
    },
    'demo.slow': async () => {
      app.slow++
      await new Promise((r) => setTimeout(r, 400))
    },
    'app.reload': () => {
      app.reloads++
      if (options.dropReload) app.ws.close()
      return { reloading: true }
    },
    ...(options.restore === false
      ? {}
      : {
          'bridge.restore': () => {
            app.restores++
            app.changed = false
            return { undone: 2 }
          },
        }),
  }
  for (const name of [...(options.dropOnce ?? []), ...(options.counted ?? [])]) {
    tools[name] = () => {
      app.runs[name] = (app.runs[name] ?? 0) + 1
      if (app.runs[name] === 1 && options.dropOnce?.includes(name)) app.ws.close()
      return 'ran'
    }
  }
  type Registry = ReturnType<typeof createRegistry>
  let registry: Registry
  const getAll = (): Tools => ({
    ...bridgeTools(() => registry.list()),
    ...tools,
    ...extra,
  })
  let extra: Tools = options.extra?.(getAll) ?? {}
  const make = (): Registry =>
    // Its own slot: apps in one test process are separate loads.
    createRegistry(getAll, logs, options.noLoadId ? undefined : loadId, {})
  registry = make()
  const info = (): DeviceInfo => ({
    deviceId,
    name: options.name ?? 'Fake App',
    platform: 'ios',
    protocol: PROTOCOL_VERSION,
    loadId: options.noLoadId ? undefined : loadId,
    tools: registry.list(),
  })
  const ws = new WebSocket(`ws://${metro}/expo-dev-plugins/broadcast`)
  await new Promise((r) => ws.once('open', r))
  const send = (method: string, payload: unknown) =>
    ws.readyState === 1 &&
    ws.send(
      JSON.stringify({
        messageKey: { pluginName: PLUGIN_NAME, method },
        payload,
      }),
    )
  ws.on('message', async (data) => {
    const { messageKey, payload } = JSON.parse(String(data))
    if (messageKey.pluginName !== PLUGIN_NAME) return
    if (messageKey.method === 'hello') send('hello:reply', info())
    // Calls to an id this runtime no longer has are dropped, as in the app.
    if (messageKey.method === 'call' && payload.to === deviceId) {
      app.onCall?.(payload.tool, payload.args ?? [])
      // An extra field, like the logs a newer app sends, must pass through.
      send('result', {
        ...(await registry.dispatch(payload, deviceId)),
        extra: 'kept',
      })
    }
  })
  app.ws = ws
  return app
}

let dir = ''
/** The first mmkv.get on any fake app loses its reply. */
let getDropped = false
const cleanups: Array<() => unknown> = []
beforeEach(() => {
  getDropped = false
  dir = mkdtempSync(join(tmpdir(), 'ab-'))
  process.env.AGENT_BRIDGE_STATE_DIR = dir
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  delete process.env.AGENT_BRIDGE_STATE_DIR
  rmSync(dir, { recursive: true, force: true })
})

async function setup(options: Parameters<typeof fakeApp>[2] = {}) {
  const metro = await startFakeMetro({ expo: true })
  cleanups.push(metro.close)
  const app = await fakeApp(metro.metro, 'dev-1', options)
  cleanups.push(() => app.ws.close())
  return { metro: metro.metro, app, fake: metro }
}

describe('session daemon', () => {
  test('serves calls on one connection; stop runs bridge.restore', async () => {
    const { metro, app } = await setup()
    const daemon = await runSessionDaemon({
      name: 'one',
      metro,
      idleMs: 0,
      healthMs: 0,
    })
    cleanups.push(() => daemon.stop(true))

    const files = sessionFiles('one', dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(files.state).mode & 0o777).toBe(0o600)
    expect(statSync(files.socket).mode & 0o777).toBe(0o600)
    expect(listSessions().map((s) => s.name)).toEqual(['one'])

    const bridge = await connectSession({ metro })
    cleanups.push(bridge.close)
    expect(bridge.session.name).toBe('one')
    expect(bridge.device.deviceId).toBe('dev-1')
    expect(bridge.tools().map((t) => t.name)).toContain('demo.echo')
    const timed = await bridge.timed('store.get', 'hi', { n: 1 })
    expect(timed.value).toEqual(['hi', { n: 1 }])
    expect((timed as unknown as { extra: string }).extra).toBe('kept')
    expect(timed.ms).toBeGreaterThan(0)
    await expect(bridge.call('nope')).rejects.toThrow('nope: Unknown tool')

    const restore = await daemon.stop()
    expect(restore).toMatchObject({ ok: true, value: { undone: 2 } })
    expect(app.restores).toBe(1)
    expect(await daemon.done).toBe('stop')
    expect(listSessions()).toEqual([])
    expect(readFileSync(files.log, 'utf8')).toContain('stopped (stop)')
  })

  test('the health ping leaves app errors for the next real call', async () => {
    const { metro, app } = await setup()
    const daemon = await runSessionDaemon({
      name: 'pinged',
      metro,
      idleMs: 0,
      healthMs: 30,
    })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession({ metro })
    cleanups.push(bridge.close)
    await bridge.call('demo.boom')
    // An error after the call, as from a timer or a rejected promise.
    app.logs.record('error', ['late'])
    await new Promise((r) => setTimeout(r, 200))
    const next = await bridge.timed('store.get')
    expect(next.logs.map((l) => l.message)).toEqual(['late'])
    expect(next.logs[0]?.after).toBe('demo.boom')
  })

  test('one session on a non-default Metro port needs no --metro', async () => {
    const { metro } = await setup()
    expect(metro).not.toBe('localhost:8081')
    const daemon = await runSessionDaemon({
      name: 'custom',
      metro,
      idleMs: 0,
      healthMs: 0,
    })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession()
    cleanups.push(bridge.close)
    expect(bridge.session.name).toBe('custom')
    expect(await bridge.call('store.get', 1)).toEqual([1])
  })

  test('with several sessions, errors listing them; --session, --metro and --device pick one', async () => {
    const a = await setup()
    const b = await setup()
    for (const [name, metro] of [
      ['first', a.metro],
      ['second', b.metro],
    ] as const) {
      const daemon = await runSessionDaemon({
        name,
        metro,
        idleMs: 0,
        healthMs: 0,
      })
      cleanups.push(() => daemon.stop(true))
    }
    await expect(connectSession()).rejects.toThrow(
      /Several sessions match \(first: Fake App on .*; second: Fake App on .*\)/,
    )
    for (const [options, name] of [
      [{ name: 'second' }, 'second'],
      [{ metro: a.metro }, 'first'],
      [{ metro: `http://${b.metro}/` }, 'second'],
    ] as const) {
      const bridge = await connectSession(options)
      cleanups.push(bridge.close)
      expect(bridge.session.name).toBe(name)
    }
    const saved = process.env.AGENT_BRIDGE_METRO
    process.env.AGENT_BRIDGE_METRO = b.metro
    try {
      const bridge = await connectSession()
      cleanups.push(bridge.close)
      expect(bridge.session.name).toBe('second')
    } finally {
      if (saved === undefined) delete process.env.AGENT_BRIDGE_METRO
      else process.env.AGENT_BRIDGE_METRO = saved
    }
    // An explicit filter that matches nothing is still an error, not a guess.
    await expect(connectSession({ device: 'nope' })).rejects.toThrow(
      'No single session matches',
    )
  })

  test('passes a 2 MB result through the socket whole', async () => {
    const { metro } = await setup()
    const daemon = await runSessionDaemon({
      name: 'big',
      metro,
      idleMs: 0,
      healthMs: 0,
    })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession({ metro, timeoutMs: 30_000 })
    cleanups.push(bridge.close)
    expect(await bridge.call('demo.big', 2_000_000)).toEqual(
      bigValue(2_000_000),
    )
  })

  test('tears down after the idle period, restoring first', async () => {
    const { metro, app } = await setup()
    const daemon = await runSessionDaemon({
      name: 'idle',
      metro,
      idleMs: 150,
      healthMs: 0,
    })
    cleanups.push(() => daemon.stop(true))
    expect(await daemon.done).toBe('idle')
    expect(app.restores).toBe(1)
    expect(listSessions()).toEqual([])
  })

  test('an app without bridge.restore answers stop with Unknown tool', async () => {
    const { metro, app } = await setup({ restore: false })
    const daemon = await runSessionDaemon({
      name: 'k',
      metro,
      idleMs: 0,
      healthMs: 0,
    })
    const restore = await daemon.stop()
    expect(restore?.ok === false && restore.error).toContain('Unknown tool')
    expect(app.restores).toBe(0)
  })

  test('refuses a second session for an app that already has one', async () => {
    const { metro, app } = await setup()
    const daemon = await runSessionDaemon({
      name: 'owner',
      metro,
      idleMs: 0,
      healthMs: 0,
    })
    cleanups.push(() => daemon.stop(true))
    await expect(
      runSessionDaemon({ name: 'other', metro, idleMs: 0, healthMs: 0 }),
    ).rejects.toThrow('already belongs to session "owner"')
    await expect(
      runSessionDaemon({ name: 'owner', metro, idleMs: 0, healthMs: 0 }),
    ).rejects.toThrow('"owner" is already running')
    // --keep: no restore.
    expect(await daemon.stop(true)).toBeNull()
    expect(app.restores).toBe(0)
  })

  test('notices a reload between calls with the health ping', async () => {
    const { metro, app } = await setup()
    const daemon = await runSessionDaemon({
      name: 'health',
      metro,
      idleMs: 0,
      healthMs: 50,
    })
    cleanups.push(() => daemon.stop(true))
    app.ws.close()
    const reloaded = await fakeApp(metro, 'dev-2')
    cleanups.push(() => reloaded.ws.close())
    for (let i = 0; i < 100; i++) {
      if (listSessions()[0]?.device.deviceId === 'dev-2') break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(listSessions()[0]?.device.deviceId).toBe('dev-2')
  }, 10_000)

  test('re-discovers a reloaded app and retries; reports an app that is gone', async () => {
    const { metro, app } = await setup()
    const daemon = await runSessionDaemon({
      name: 're',
      metro,
      idleMs: 0,
      healthMs: 0,
    })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession({ name: 're', timeoutMs: 300 })
    cleanups.push(bridge.close)
    expect(await bridge.call('store.get', 1)).toEqual([1])

    // A reload: same app, new device id.
    app.ws.close()
    const reloaded = await fakeApp(metro, 'dev-2')
    cleanups.push(() => reloaded.ws.close())
    expect(await bridge.call('store.get', 2)).toEqual([2])
    expect(listSessions()[0]?.device.deviceId).toBe('dev-2')

    reloaded.ws.close()
    await expect(bridge.call('store.get', 3)).rejects.toThrow('The app is gone')
  }, 15_000)

  test('never reconnects to another app; waits for the one it started on', async () => {
    const { metro, app } = await setup()
    const daemon = await runSessionDaemon({
      name: 'pinned',
      metro,
      idleMs: 0,
      healthMs: 0,
    })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession({ name: 'pinned', timeoutMs: 300 })
    cleanups.push(bridge.close)
    expect(await bridge.call('store.get', 1)).toEqual([1])

    // The app goes; another app on the same Metro is all that is left.
    app.ws.close()
    const other = await fakeApp(metro, 'dev-9', { name: 'Other App' })
    cleanups.push(() => other.ws.close())
    await expect(bridge.call('demo.set')).rejects.toThrow(
      'Fake App (ios) is not connected; connected: Other App (ios, dev-9)',
    )
    expect(other.changed).toBe(false)
    expect(listSessions()[0]?.device).toMatchObject({
      name: 'Fake App',
      deviceId: 'dev-1',
    })

    // The same app coming back (reloaded, so a new id) is picked up again.
    const back = await fakeApp(metro, 'dev-2')
    cleanups.push(() => back.ws.close())
    expect(await bridge.call('store.get', 2)).toEqual([2])
    expect(listSessions()[0]?.device.deviceId).toBe('dev-2')
  }, 15_000)

  test('the health ping does not move a session to another app either', async () => {
    const { metro, app } = await setup()
    const daemon = await runSessionDaemon({
      name: 'pinned-health',
      metro,
      idleMs: 0,
      healthMs: 50,
    })
    cleanups.push(() => daemon.stop(true))
    app.ws.close()
    const other = await fakeApp(metro, 'dev-9', { name: 'Other App' })
    cleanups.push(() => other.ws.close())
    const log = () =>
      readFileSync(sessionFiles('pinned-health', dir).log, 'utf8')
    for (let i = 0; i < 100 && !/reconnect(ed|.*failed)/.test(log()); i++)
      await new Promise((r) => setTimeout(r, 50))
    expect(log()).toContain('Fake App (ios) is not connected')
    expect(listSessions()[0]?.device.deviceId).toBe('dev-1')
  }, 10_000)

  test('a reconnect skips an app that belongs to another session', async () => {
    const { metro, app } = await setup()
    const first = await runSessionDaemon({
      name: 'first',
      metro,
      idleMs: 0,
      healthMs: 0,
    })
    cleanups.push(() => first.stop(true))
    // The same app on a second device, driven by its own session.
    const twin = await fakeApp(metro, 'dev-2')
    cleanups.push(() => twin.ws.close())
    const second = await runSessionDaemon({
      name: 'second',
      metro,
      device: 'dev-2',
      idleMs: 0,
      healthMs: 0,
    })
    cleanups.push(() => second.stop(true))

    app.ws.close()
    const bridge = await connectSession({ name: 'first', timeoutMs: 300 })
    cleanups.push(bridge.close)
    await expect(bridge.call('demo.set')).rejects.toThrow(
      'belongs to session "second"',
    )
    expect(twin.changed).toBe(false)
    expect(
      listSessions().find((s) => s.name === 'first')?.device.deviceId,
    ).toBe('dev-1')
  }, 15_000)

  test('--device matching several apps is an error that lists them', async () => {
    const { metro } = await setup()
    const twin = await fakeApp(metro, 'dev-2')
    cleanups.push(() => twin.ws.close())
    await expect(
      runSessionDaemon({
        name: 'loose',
        metro,
        device: 'fake',
        transport: 'expo',
        idleMs: 0,
        healthMs: 0,
      }),
    ).rejects.toThrow(
      '2 apps match "fake"; narrow --device. Matching: Fake App (ios, dev-1); Fake App (ios, dev-2)',
    )
    const exact = await runSessionDaemon({
      name: 'exact',
      metro,
      device: 'dev-2',
      transport: 'expo',
      idleMs: 0,
      healthMs: 0,
    })
    cleanups.push(() => exact.stop(true))
    expect(exact.state.device.deviceId).toBe('dev-2')
  })

  /** A session on a fresh fake app plus a client for it. */
  async function session(
    name: string,
    options: {
      timeoutMs?: number
      reloadWaitMs?: number
      app?: Parameters<typeof fakeApp>[2]
    } = {},
  ) {
    const { metro, app } = await setup(options.app)
    const daemon = await runSessionDaemon({
      name,
      metro,
      idleMs: 0,
      healthMs: 0,
      reloadWaitMs: options.reloadWaitMs,
    })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession({
      name,
      timeoutMs: options.timeoutMs ?? 300,
    })
    cleanups.push(bridge.close)
    return { metro, app, daemon, bridge }
  }
  test('a client that closes with its reply unread does not take the session down', async () => {
    await session('reset')
    const state = listSessions()[0]!
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => uncaught.push(error)
    process.on('uncaughtException', onUncaught)
    try {
      const raw = connect(state.socket)
      raw.on('error', () => {})
      await new Promise<void>((r) => raw.once('connect', r))
      // Only bytes left unread in the kernel make the close a reset; a small reply is read at once.
      const big = 'x'.repeat(3_000_000)
      raw.write(`${JSON.stringify({ id: 1, op: 'call', tool: 'store.get', args: [big] })}\n`)
      raw.pause()
      await new Promise((r) => setTimeout(r, 300))
      raw.destroy()
      await new Promise((r) => setTimeout(r, 100))
      expect(uncaught).toEqual([])
      expect((await sessionRequest(state, { op: 'info' })).error).toBeUndefined()
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })

  const LOST = 'app reloaded; 1 pending restore lost: demo'

  test('reports the restores a reload lost, once in the next call and again on stop', async () => {
    const { metro, app, bridge } = await session('lost')
    await bridge.call('demo.set')
    expect((await bridge.timed('store.get', 1)).notice).toBeUndefined()

    // The old app's socket goes; a new runtime with a new load id comes up.
    app.ws.close()
    const reloaded = await fakeApp(metro, 'dev-2', { loadId: 'load-2' })
    cleanups.push(() => reloaded.ws.close())
    const next = await bridge.timed('store.get', 2)
    expect(next.value).toEqual([2])
    expect(next.notice).toBe(LOST)
    expect((await bridge.timed('store.get', 3)).notice).toBeUndefined()
    expect(readFileSync(sessionFiles('lost', dir).log, 'utf8')).toContain(
      `warning: ${LOST}`,
    )

    const stopped = await sessionRequest(listSessions()[0]!, { op: 'stop' })
    expect(stopped.notice).toBe(LOST)
    expect(reloaded.restores).toBe(1)
  }, 15_000)

  test('a call whose reply was lost is not run again, and says so', async () => {
    const { metro, app, bridge } = await session('nodup')
    const reloaded = await fakeApp(metro, 'dev-2', { loadId: 'load-2' })
    cleanups.push(() => reloaded.ws.close())
    const error = await bridge.call('demo.drop').catch((e: Error) => e)
    expect(error).toBeInstanceOf(AgentBridgeCallError)
    expect((error as Error).message).toContain(
      'the app reloaded during demo.drop; it may or may not have run',
    )
    expect(app.drops).toBe(1)
    expect(reloaded.drops).toBe(0)
    // The session is back on the new app for the next call.
    expect((await bridge.timed('store.get', 1)).value).toEqual([1])
  }, 15_000)

  test('a read-only call whose reply was lost is run again on the reconnect', async () => {
    const { metro, app, bridge } = await session('retry')
    const reloaded = await fakeApp(metro, 'dev-2', { loadId: 'load-2' })
    cleanups.push(() => reloaded.ws.close())
    expect(await bridge.call('mmkv.get')).toBe('got')
    expect(app.drops).toBe(1)
    expect(reloaded.drops).toBe(1)
  }, 15_000)

  test('a call whose reply was lost says the connection dropped when no reload is known', async () => {
    const { metro, bridge } = await session('wording', {
      app: { noLoadId: true },
    })
    const again = await fakeApp(metro, 'dev-2', { noLoadId: true })
    cleanups.push(() => again.ws.close())
    const error = await bridge.call('demo.drop').catch((e: Error) => e)
    expect((error as Error).message).toContain(
      'the connection dropped during demo.drop; it may or may not have run',
    )
  }, 15_000)

  test('the same app back on the same load says it disconnected, not reloaded', async () => {
    const { metro, bridge } = await session('wording2')
    const again = await fakeApp(metro, 'dev-2')
    cleanups.push(() => again.ws.close())
    const error = await bridge.call('demo.drop').catch((e: Error) => e)
    expect((error as Error).message).toContain(
      'the app disconnected during demo.drop; it may or may not have run',
    )
  }, 15_000)

  test('a failed reconnect still says the call may have run', async () => {
    const { bridge, app } = await session('gone')
    const error = await bridge.call('demo.drop').catch((e: Error) => e)
    expect((error as Error).message).toContain(
      'during demo.drop; it may or may not have run',
    )
    expect((error as Error).message).toContain('Reconnecting failed')
    expect(app.drops).toBe(1)
  }, 15_000)

  test('bridge.restore is not run again after a lost reply', async () => {
    const { metro, app, bridge } = await session('restore-lost', {
      app: { dropOnce: ['bridge.restore'] },
    })
    const again = await fakeApp(metro, 'dev-2', { dropOnce: ['bridge.restore'] })
    cleanups.push(() => again.ws.close())
    const error = await bridge.call('bridge.restore').catch((e: Error) => e)
    expect((error as Error).message).toContain('may or may not have run')
    expect(app.runs['bridge.restore']).toBe(1)
    expect(again.runs['bridge.restore'] ?? 0).toBe(0)
  }, 15_000)

  test('an app tool that merely ends in .log is not run again', async () => {
    const { metro, app, bridge } = await session('applog', {
      app: { dropOnce: ['analytics.log'] },
    })
    const again = await fakeApp(metro, 'dev-2', { dropOnce: ['analytics.log'] })
    cleanups.push(() => again.ws.close())
    const error = await bridge.call('analytics.log', 'event').catch((e: Error) => e)
    expect((error as Error).message).toContain('may or may not have run')
    expect(app.runs['analytics.log']).toBe(1)
    expect(again.runs['analytics.log'] ?? 0).toBe(0)
  }, 15_000)

  for (const tool of ['net.log', 'bridge.logs']) {
    test(`${tool} is run again after a lost reply, but not with clear: true`, async () => {
      const first = await session(`log-${tool}`, { app: { dropOnce: [tool] } })
      const again = await fakeApp(first.metro, 'dev-2', { counted: [tool] })
      cleanups.push(() => again.ws.close())
      expect(await first.bridge.call(tool)).toBe('ran')
      expect(first.app.runs[tool]).toBe(1)
      expect(again.runs[tool]).toBe(1)

      const next = await session(`log-clear-${tool}`, { app: { dropOnce: [tool] } })
      const plain = await fakeApp(next.metro, 'dev-2', { counted: [tool] })
      cleanups.push(() => plain.ws.close())
      const error = await next.bridge.call(tool, { clear: true }).catch((e: Error) => e)
      expect((error as Error).message).toContain('may or may not have run')
      expect(plain.runs[tool] ?? 0).toBe(0)
    }, 20_000)
  }

  test('a wait for something to go away is not repeated after a reload', async () => {
    const { metro, bridge } = await session('gone-wait', {
      app: { dropOnce: ['screen.waitFor'] },
    })
    const again = await fakeApp(metro, 'dev-2', { loadId: 'load-2', dropOnce: ['screen.waitFor'] })
    cleanups.push(() => again.ws.close())
    const error = await bridge
      .call('screen.waitFor', 'Spinner', { gone: true })
      .catch((e: Error) => e)
    expect((error as Error).message).toContain('may or may not have run')
    expect(again.runs['screen.waitFor'] ?? 0).toBe(0)
  }, 15_000)

  test('a repeated wait gets only the time left', async () => {
    const seen: unknown[] = []
    const { metro, bridge } = await session('time-left', {
      app: { dropOnce: ['screen.waitFor'] },
    })
    const again = await fakeApp(metro, 'dev-2', { loadId: 'load-1' })
    cleanups.push(() => again.ws.close())
    again.onCall = (tool, args) => {
      if (tool === 'screen.waitFor') seen.push(args)
    }
    await bridge.call('screen.waitFor', 'Done', { timeoutMs: 8000 }).catch(() => {})
    const opts = (seen[0] as unknown[] | undefined)?.[1] as { timeoutMs: number } | undefined
    expect(opts?.timeoutMs).toBeLessThan(8000)
    expect(opts?.timeoutMs).toBeGreaterThan(0)
  }, 15_000)

  test('stop --dry-run lists what restore would undo and keeps the session; --keep reports it', async () => {
    const { app, bridge } = await session('dry')
    const state = listSessions()[0]!
    await bridge.call('demo.set')

    const dry = await sessionRequest(state, { op: 'stop', dryRun: true })
    expect(dry.pending).toEqual({ demo: { key: { snapshot: 1, current: 2 } } })
    expect(dry.restore).toBeUndefined()
    expect(app.restores).toBe(0)
    expect(listSessions().map((s) => s.name)).toEqual(['dry'])
    expect(await bridge.call('store.get', 1)).toEqual([1])

    const kept = await sessionRequest(state, { op: 'stop', keep: true })
    expect(kept.restore).toBeNull()
    expect(kept.pending).toEqual({
      demo: { key: { snapshot: 1, current: 2 } },
    })
    expect(app.restores).toBe(0)
  })

  test('a plain stop reports no pending', async () => {
    const { app } = await session('plain')
    const stopped = await sessionRequest(listSessions()[0]!, { op: 'stop' })
    expect(stopped.pending).toBeUndefined()
    expect(app.restores).toBe(1)
  })

  test('an app without bridge.pending still stops, and a dry run has nothing to list', async () => {
    const { app } = await session('old-app', { app: { pending: false } })
    const state = listSessions()[0]!
    const dry = await sessionRequest(state, { op: 'stop', dryRun: true })
    expect(dry.pending).toBeUndefined()
    expect(dry.restore).toBeUndefined()
    expect(listSessions()).toHaveLength(1)
    const stopped = await sessionRequest(state, { op: 'stop' })
    expect(stopped.restore).toMatchObject({ ok: true })
    expect(app.restores).toBe(1)
  })

  test('a dry run while the session is stopping reports that, not "still running"', async () => {
    const { daemon } = await session('stopping')
    const state = listSessions()[0]!
    const stopping = daemon.stop()
    const dry = await sessionRequest(state, { op: 'stop', dryRun: true }).catch(
      (error: Error) => ({ error: error.message }),
    )
    await stopping
    expect(dry).toMatchObject({
      error: expect.stringMatching(/stopping|closed|isn't answering/),
    })
  })

  describe('session stop --dry-run in the CLI', () => {
    const run = async (flags: Parameters<typeof sessionCommand>[1]) => {
      const lines: string[] = []
      const log = console.log
      console.log = (...a: unknown[]) => void lines.push(a.join(' '))
      const kill = process.kill
      const signals: unknown[] = []
      process.kill = ((pid: number, signal?: string | number) => {
        if (signal === 0) return kill(pid, 0)
        signals.push(signal)
        return true
      }) as typeof process.kill
      try {
        await sessionCommand('stop', flags)
      } finally {
        console.log = log
        process.kill = kill
      }
      return { out: lines.join('\n'), signals }
    }
    /** A state file for a daemon that answers with `respond`, or hangs up on every request. */
    const fakeDaemon = async (
      name: string,
      respond?: (req: { id: number }) => object,
    ) => {
      const files = sessionFiles(name, dir)
      writePrivate(
        files.state,
        JSON.stringify({
          name,
          pid: process.pid,
          socket: files.socket,
          metro: 'localhost:8081',
          device: { name: 'Old', deviceId: 'd', platform: 'ios' },
          transport: 'cdp',
          startedAt: 1,
          lastCallAt: 1,
          idleMs: 0,
        }),
      )
      const server = createServer((socket) => {
        socket.on('error', () => {})
        if (!respond) return void socket.end()
        const lines = createInterface({ input: socket })
        lines.on('error', () => {})
        lines.on('line', (line) =>
          socket.write(`${JSON.stringify(respond(JSON.parse(line)))}\n`),
        )
      })
      await new Promise<void>((r) => server.listen(files.socket, r))
      cleanups.push(() => server.close())
    }

    test('lists pending and says the session is still running', async () => {
      const { app } = await session('cli-dry')
      await sessionRequest(listSessions()[0]!, {
        op: 'call',
        tool: 'demo.set',
      })
      const { out, signals } = await run({ name: 'cli-dry', 'dry-run': true })
      expect(out).toContain('still running')
      expect(out).toContain('demo: {"key":{"snapshot":1,"current":2}}')
      expect(signals).toEqual([])
      expect(app.restores).toBe(0)
    })

    test('never sends SIGTERM when the daemon does not answer', async () => {
      await fakeDaemon('mute')
      const { out, signals } = await run({ name: 'mute', 'dry-run': true })
      expect(signals).toEqual([])
      expect(out).toContain('Dry run failed')
      expect(out).toContain('Nothing was stopped or restored')
    })

    test('says so when an older daemon ignored the dry run and stopped', async () => {
      await fakeDaemon('older', (req) => ({
        id: req.id,
        restore: { id: 'r', from: 'd', ok: true, value: { undone: 2 }, ms: 1 },
      }))
      const { out, signals } = await run({ name: 'older', 'dry-run': true })
      expect(signals).toEqual([])
      expect(out).toContain('predates --dry-run')
      expect(out).toContain('bridge.restore: {"undone":2}')
      expect(out).not.toContain('still running')
    })

    test('a plain stop that gets no answer still sends SIGTERM', async () => {
      await fakeDaemon('plain-mute')
      const { signals } = await run({ name: 'plain-mute' })
      expect(signals).toEqual(['SIGTERM'])
    })
  })

  test('a failing call after a reload still carries the notice', async () => {
    const { app, bridge } = await session('fails')
    await bridge.call('demo.set')
    app.reload('dev-2', 'load-2')
    const error = await bridge.call('demo.nope').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AgentBridgeCallError)
    expect((error as AgentBridgeCallError).notice).toBe(LOST)
    expect((error as Error).message).toContain(`Warning: ${LOST}`)
  }, 15_000)

  test('a new device id on the same socket fails fast and reports the reload', async () => {
    const { app, bridge } = await session('fast', { timeoutMs: 8000 })
    await bridge.call('demo.set')
    app.reload('dev-2', 'load-2')
    const t0 = performance.now()
    const next = await bridge.timed('store.get', 2)
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(next.notice).toBe(LOST)
    expect(listSessions()[0]?.device.deviceId).toBe('dev-2')
  }, 15_000)

  test('Fast Refresh (new device id, same load id) is not a reload', async () => {
    const { app, bridge } = await session('refresh', { timeoutMs: 8000 })
    await bridge.call('demo.set')
    app.reload('dev-2')
    const next = await bridge.timed('store.get', 2)
    expect(next.notice).toBeUndefined()
    expect(listSessions()[0]?.device.deviceId).toBe('dev-2')
    const stopped = await sessionRequest(listSessions()[0]!, { op: 'stop' })
    expect(stopped.notice).toBeUndefined()
  }, 15_000)

  test('a new load id in a reply is caught without reconnecting', async () => {
    const { app, bridge } = await session('reply')
    await bridge.call('demo.set')
    // Same connection, same device id: only the reply's load id differs.
    app.reload('dev-1', 'load-2')
    const next = await bridge.timed('store.get', 2)
    expect(next.notice).toBe(LOST)
    expect(readFileSync(sessionFiles('reply', dir).log, 'utf8')).not.toContain(
      'reconnecting',
    )
  }, 15_000)

  test('says nothing when nothing reloaded, and 0 restores when none were pending', async () => {
    const { app, bridge } = await session('none')
    await bridge.call('demo.set')
    await bridge.call('bridge.restore')
    for (let i = 0; i < 3; i++)
      expect((await bridge.timed('store.get', i)).notice).toBeUndefined()
    app.reload('dev-1', 'load-2')
    expect((await bridge.timed('store.get', 4)).notice).toBe(
      'app reloaded; 0 pending restores lost',
    )
  }, 15_000)

  test('a direct demo.restore clears its area from the lost list', async () => {
    const { app, bridge } = await session('cleared')
    await bridge.call('demo.set')
    await bridge.call('demo.restore')
    app.reload('dev-1', 'load-2')
    expect((await bridge.timed('store.get', 1)).notice).toBe(
      'app reloaded; 0 pending restores lost',
    )
  }, 15_000)

  describe('app.reload', () => {
    // The old runtime leaves, and the new one takes a while to come up.
    const comeBack = (metro: string, old: WebSocket) => {
      old.close()
      setTimeout(async () => {
        const next = await fakeApp(metro, 'dev-2', { loadId: 'load-2' })
        cleanups.push(() => next.ws.close())
      }, 600)
    }

    test('is not run again when its reply is lost; the next call waits for the new bridge', async () => {
      const { metro, app, bridge } = await session('once', {
        app: { dropReload: true },
      })
      await bridge.call('demo.set')
      expect(await bridge.call('app.reload')).toEqual({ reloading: true })
      expect(app.reloads).toBe(1)
      setTimeout(async () => {
        const next = await fakeApp(metro, 'dev-2', { loadId: 'load-2' })
        cleanups.push(() => next.ws.close())
      }, 600)
      const next = await bridge.timed('store.get', 1)
      expect(next.value).toEqual([1])
      expect(next.notice).toBe(LOST)
      expect(app.reloads).toBe(1)
    }, 20_000)

    test('the call after it waits for the bridge to come back', async () => {
      const { metro, app, bridge } = await session('wait')
      await bridge.call('demo.set')
      expect(await bridge.call('app.reload')).toEqual({ reloading: true })
      comeBack(metro, app.ws)
      const next = await bridge.timed('store.get', 1)
      expect(next.notice).toBe(LOST)
    }, 20_000)

    test('says the app is reloading when the bridge never comes back', async () => {
      const { app, bridge } = await session('gone', { reloadWaitMs: 1000 })
      expect(await bridge.call('app.reload')).toEqual({ reloading: true })
      app.ws.close()
      await expect(bridge.call('store.get', 1)).rejects.toThrow(
        "The app is reloading; its bridge isn't ready yet",
      )
    }, 20_000)
  })

  describe('a reconnect that hangs', () => {
    /** A session whose Metro stops answering, then loses the app. */
    async function hung(name: string, healthMs = 0) {
      const { metro, app, fake } = await setup()
      const daemon = await runSessionDaemon({
        name,
        metro,
        idleMs: 0,
        healthMs,
        attemptMs: 1000,
      })
      cleanups.push(() => daemon.stop(true))
      const bridge = await connectSession({ name, timeoutMs: 300 })
      cleanups.push(bridge.close)
      expect(await bridge.call('store.get', 1)).toEqual([1])
      fake.live.hangList = true
      fake.live.hangUpgrade = true
      app.ws.close()
      return { metro, fake, daemon, bridge }
    }

    test('calls fail within one attempt instead of hanging', async () => {
      const { bridge } = await hung('fast')
      const t0 = Date.now()
      const gone = /app not connected|The app is gone/
      await expect(bridge.call('store.get', 2)).rejects.toThrow(gone)
      await expect(bridge.call('store.get', 3)).rejects.toThrow(gone)
      expect(Date.now() - t0).toBeLessThan(9000)
    }, 15_000)

    test('stop completes while the reconnect is stuck', async () => {
      const { daemon, bridge } = await hung('stop')
      await expect(bridge.call('store.get', 2)).rejects.toThrow(
        /app not connected|The app is gone/,
      )
      const stopped = await Promise.race([
        daemon.stop(),
        new Promise((r) => setTimeout(() => r('hung'), 4000)),
      ])
      expect(stopped).not.toBe('hung')
      expect(await daemon.done).toBe('stop')
      expect(listSessions()).toEqual([])
    }, 10_000)

    test('stop completes when Metro goes away mid-reconnect', async () => {
      const { fake, daemon, bridge } = await hung('gone-metro')
      await expect(bridge.call('store.get', 2)).rejects.toThrow(
        /app not connected|The app is gone/,
      )
      await fake.close()
      const stopped = await Promise.race([
        daemon.stop(true),
        new Promise((r) => setTimeout(() => r('hung'), 4000)),
      ])
      expect(stopped).not.toBe('hung')
    }, 10_000)

    test('reconnects on the health tick once the stuck attempt gives up', async () => {
      const { metro, fake } = await hung('retry', 50)
      // Wait until the daemon is stuck inside an attempt, then let Metro answer.
      while (!fake.heldCount()) await new Promise((r) => setTimeout(r, 10))
      fake.live.hangList = false
      fake.live.hangUpgrade = false
      const reloaded = await fakeApp(metro, 'dev-2')
      cleanups.push(() => reloaded.ws.close())
      while (listSessions()[0]?.device.deviceId !== 'dev-2')
        await new Promise((r) => setTimeout(r, 25))
    }, 15_000)
  })

  test('stop restores through a reconnect when the app is back', async () => {
    const { metro, app, bridge, daemon } = await session('restore-back')
    await bridge.call('demo.set')
    app.ws.close()
    await expect(bridge.call('store.get', 1)).rejects.toThrow('The app is gone')
    const reloaded = await fakeApp(metro, 'dev-2')
    cleanups.push(() => reloaded.ws.close())
    expect(await daemon.stop()).toMatchObject({
      ok: true,
      value: { undone: 2 },
    })
    expect(reloaded.restores).toBe(1)
  }, 15_000)

  test('a slow tool times out without a retry while the app still answers', async () => {
    const { metro, app } = await setup()
    const daemon = await runSessionDaemon({
      name: 'slow',
      metro,
      idleMs: 0,
      healthMs: 0,
    })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession({ name: 'slow', timeoutMs: 150 })
    cleanups.push(bridge.close)
    await expect(bridge.call('demo.slow')).rejects.toThrow(
      'No reply to "demo.slow"',
    )
    expect(app.slow).toBe(1)
  })

  test('removes state left by a daemon that died', () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid
    expect(isAlive(dead)).toBe(false)
    writePrivate(
      sessionFiles('ghost', dir).state,
      JSON.stringify({ name: 'ghost', pid: dead, startedAt: 0 }),
    )
    expect(listSessions()).toEqual([])
    expect(() => statSync(sessionFiles('ghost', dir).state)).toThrow()
  })

  test('parses durations', () => {
    expect(parseDuration('15m')).toBe(900_000)
    expect(parseDuration('1.5s')).toBe(1500)
    expect(parseDuration('250')).toBe(250)
    expect(() => parseDuration('soon')).toThrow()
  })
})

describe('session CLI', () => {
  const cli = resolve(import.meta.dir, '../../../cli.ts')
  const run = (...args: string[]) => {
    const out = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_BRIDGE_STATE_DIR: dir },
    })
    return { code: out.status, stdout: out.stdout, stderr: out.stderr }
  }
  // spawnSync would block the fake app in this process, so run the CLI async.
  const runAsync = (...args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (done) => {
        const child = Bun.spawn([process.execPath, cli, ...args], {
          env: { ...process.env, AGENT_BRIDGE_STATE_DIR: dir },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        void Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]).then(([stdout, stderr, code]) => done({ code, stdout, stderr }))
      },
    )

  test('start, call through it, --no-session, list, stop', async () => {
    const { metro, app } = await setup()
    const started = await runAsync(
      'session',
      'start',
      '--metro',
      metro,
      '--name',
      'cli',
      '--idle',
      '1m',
    )
    expect(started.stderr).toBe('')
    expect(started.stdout).toContain('Session "cli": Fake App via expo')
    const pid = listSessions()[0]?.pid as number
    cleanups.push(() => {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL')
    })

    const before = listSessions()[0]?.lastCallAt as number
    const direct = await runAsync(
      'call',
      'demo.echo',
      '"x"',
      '--metro',
      metro,
      '--no-session',
    )
    expect(direct.stdout).toContain('"x"')
    expect(listSessions()[0]?.lastCallAt).toBe(before)

    const viaSession = await runAsync(
      'call',
      'demo.echo',
      '"y"',
      '--metro',
      metro,
    )
    expect(viaSession.stdout).toContain('"y"')
    expect(viaSession.stderr).toContain(
      `Using session "cli" (Fake App on ${metro})`,
    )
    // No --metro at all: this project's one session is used, and named.
    const plain = await runAsync('call', 'demo.echo', '"z"')
    expect(plain.stdout).toContain('"z"')
    expect(plain.stderr).toContain('Using session "cli"')
    expect(listSessions()[0]?.lastCallAt).toBeGreaterThan(before)

    expect(run('session', 'list').stdout).toMatch(/cli .*Fake App.*left/)
    const again = await runAsync('session', 'start', '--metro', metro)
    expect(again.stderr).toContain('already belongs to session "cli"')

    const stopped = await runAsync('session', 'stop', '--name', 'cli')
    expect(stopped.stdout).toContain('bridge.restore: {"undone":2}')
    expect(app.restores).toBe(1)
    for (let i = 0; i < 50 && isAlive(pid); i++)
      await new Promise((r) => setTimeout(r, 20))
    expect(isAlive(pid)).toBe(false)
    expect(run('session', 'list').stdout).toContain('No sessions.')
  })

  test('sessions from another project are ignored unless selected', () => {
    const fake = (name: string, project: string, metro: string) =>
      writePrivate(
        sessionFiles(name, dir).state,
        JSON.stringify({
          name,
          pid: process.pid,
          socket: '',
          metro,
          project,
          device: { name: 'Fake App', deviceId: name, platform: 'ios' },
          transport: 'expo',
          startedAt: Date.now(),
          lastCallAt: Date.now(),
          idleMs: 0,
        }),
      )
    fake('theirs', '/elsewhere/project-x', 'localhost:8082')
    expect(sessionFor({})).toBeNull()
    expect(sessionFor({ metro: 'localhost:8082' })?.name).toBe('theirs')
    expect(sessionFor({ session: 'theirs' })?.name).toBe('theirs')
    expect(sessionFor({ 'no-session': true })).toBeNull()

    fake('mine', projectRoot(), 'localhost:8083')
    expect(sessionFor({})?.name).toBe('mine')
    fake('mine2', projectRoot(), 'localhost:8084')
    expect(() => sessionFor({})).toThrow(
      /Several sessions match \(.*mine.*mine2|mine2.*mine/,
    )
    expect(sessionFor({ metro: 'localhost:8084' })?.name).toBe('mine2')
  })

  test('a command in a monorepo root finds the one session started in a child app', () => {
    const root = projectRoot()
    writePrivate(
      sessionFiles('child', dir).state,
      JSON.stringify({
        name: 'child',
        pid: process.pid,
        socket: '',
        metro: 'localhost:8085',
        project: join(root, 'apps', 'mobile'),
        device: { name: 'Fake App', deviceId: 'child', platform: 'ios' },
        transport: 'expo',
        startedAt: Date.now(),
        lastCallAt: Date.now(),
        idleMs: 0,
      }),
    )
    expect(sessionFor({})?.name).toBe('child')
    writePrivate(
      sessionFiles('sibling', dir).state,
      JSON.stringify({
        name: 'sibling',
        pid: process.pid,
        socket: '',
        metro: 'localhost:8086',
        project: root + '-other',
        device: { name: 'Fake App', deviceId: 'sibling', platform: 'ios' },
        transport: 'expo',
        startedAt: Date.now(),
        lastCallAt: Date.now(),
        idleMs: 0,
      }),
    )
    expect(sessionFor({})?.name).toBe('child')
  })

  describe('child-app lookup', () => {
    const fakeAt = (name: string, project: string, metro: string) =>
      writePrivate(
        sessionFiles(name, dir).state,
        JSON.stringify({
          name,
          pid: process.pid,
          socket: '',
          metro,
          project,
          device: { name: 'Fake App', deviceId: name, platform: 'ios' },
          transport: 'expo',
          startedAt: Date.now(),
          lastCallAt: Date.now(),
          idleMs: 0,
        }),
      )

    test('a session in a nested checkout of its own is not driven from the outer project', () => {
      const root = mkdtempSync(join(tmpdir(), 'ab-nested-'))
      try {
        const inner = join(root, '.claude', 'worktrees', 'x')
        mkdirSync(inner, { recursive: true })
        writeFileSync(join(root, 'package.json'), '{}')
        writeFileSync(join(inner, '.git'), 'gitdir: elsewhere')
        writeFileSync(join(inner, 'package.json'), '{}')
        fakeAt('inner', inner, 'localhost:8091')
        const cwd = process.cwd()
        process.chdir(root)
        try {
          expect(sessionFor({})).toBeNull()
        } finally {
          process.chdir(cwd)
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('a session under a package of its own is not found from above it', () => {
      const root = mkdtempSync(join(tmpdir(), 'ab-pkg-'))
      try {
        const app = join(root, 'apps', 'mobile')
        const lib = join(app, 'packages', 'lib')
        mkdirSync(lib, { recursive: true })
        for (const d of [root, app, lib])
          writeFileSync(join(d, 'package.json'), '{}')
        fakeAt('lib', lib, 'localhost:8092')
        const cwd = process.cwd()
        process.chdir(root)
        try {
          expect(sessionFor({})).toBeNull()
        } finally {
          process.chdir(cwd)
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('with no package.json anywhere, only an exact match counts', () => {
      const root = mkdtempSync(join(tmpdir(), 'ab-nopkg-'))
      try {
        const other = join(root, 'other')
        mkdirSync(other, { recursive: true })
        writeFileSync(join(other, 'package.json'), '{}')
        fakeAt('other', other, 'localhost:8093')
        const cwd = process.cwd()
        process.chdir(root)
        try {
          expect(sessionFor({})).toBeNull()
        } finally {
          process.chdir(cwd)
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('several child sessions from the root fall back to a direct connection', () => {
      const root = mkdtempSync(join(tmpdir(), 'ab-multi-'))
      try {
        writeFileSync(join(root, 'package.json'), '{}')
        for (const app of ['a', 'b']) {
          mkdirSync(join(root, 'apps', app), { recursive: true })
          writeFileSync(join(root, 'apps', app, 'package.json'), '{}')
        }
        fakeAt('a', join(root, 'apps', 'a'), 'localhost:8094')
        fakeAt('b', join(root, 'apps', 'b'), 'localhost:8095')
        const cwd = process.cwd()
        process.chdir(root)
        try {
          expect(sessionFor({})).toBeNull()
          expect(sessionFor({ metro: 'localhost:8095' })?.name).toBe('b')
        } finally {
          process.chdir(cwd)
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('the no-match error names the filter that was applied', async () => {
      await expect(connectSession({ metro: 'localhost:9' })).rejects.toThrow(
        /localhost:9/,
      )
      await expect(connectSession({ metro: 'localhost:9' })).rejects.not.toThrow(
        /started in/,
      )
      await expect(connectSession({})).rejects.toThrow(/started in/)
    })
  })

  test('start reports the connect error', async () => {
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    const out = await runAsync(
      'session',
      'start',
      '--metro',
      metro.metro,
      '--transport',
      'expo',
    )
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('No app is connected')
    expect(listSessions()).toEqual([])
  })
})

describe('restores across a reload', () => {
  // What survives an app reload: MMKV storage and a persisted store's storage.
  const disk = new Map<string, string>()
  const mem = () => {
    const kv = {
      getAllKeys: () => [...disk.keys()].filter((k) => k.startsWith('kv:')).map((k) => k.slice(3)),
      getString: (k: string) => disk.get(`kv:${k}`),
      set: (k: string, v: string | number | boolean) => void disk.set(`kv:${k}`, String(v)),
      remove: (k: string) => disk.delete(`kv:${k}`),
    }
    type Auth = { token: string }
    const auth = createStore<Auth>()(() => ({ token: disk.get('auth') ?? 'real-store' }))
    auth.subscribe((s) => void disk.set('auth', s.token))
    ;(auth as unknown as { persist: unknown }).persist = {
      getOptions: () => ({}),
      hasHydrated: () => true,
    }
    return { kv, auth }
  }
  const withStorage = (getTools: () => Tools): Tools => {
    const { kv, auth } = mem()
    return {
      ...mmkvTools({ kv }),
      ...storeTools({ auth }),
      ...restoreTools(getTools),
    }
  }

  test('a reload keeps the undo for MMKV and a persisted store; stop restores them', async () => {
    disk.clear()
    disk.set('kv:token', 'real')
    disk.set('auth', 'real-store')
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    const opts = { restore: false, extra: withStorage } as const
    const first = await fakeApp(metro.metro, 'dev-1', { ...opts, loadId: 'load-1' })
    cleanups.push(() => first.ws.close())
    const daemon = await runSessionDaemon({ name: 'rl', metro: metro.metro, idleMs: 0, healthMs: 0 })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession({ name: 'rl', timeoutMs: 1000 })
    cleanups.push(bridge.close)

    await bridge.call('mmkv.set', 'kv', 'token', 'fake')
    await bridge.call('store.set', 'auth', { token: 'fake-store' })

    first.ws.close()
    const second = await fakeApp(metro.metro, 'dev-2', { ...opts, loadId: 'load-2' })
    cleanups.push(() => second.ws.close())
    // The new load booted on the fake values; nothing is undone yet.
    expect(disk.get('kv:token')).toBe('fake')
    expect(disk.get('auth')).toBe('fake-store')

    const next = await bridge.timed('bridge.pending')
    expect(next.notice).toContain('kept 2 undos across the reload')
    expect(next.notice).not.toContain('lost')
    expect(await bridge.call('bridge.pending')).toMatchObject({ mmkv: true, store: expect.anything() })
    expect(disk.get('kv:token')).toBe('fake')

    const stopped = await daemon.stop()
    expect(stopped?.ok).toBe(true)
    expect(disk.get('kv:token')).toBe('real')
    expect(disk.get('auth')).toBe('real-store')
  }, 15_000)

  test('a store key that is not plain JSON is named in the reload notice', async () => {
    disk.clear()
    const withSet = (getTools: () => Tools): Tools => {
      const store = createStore<{ token: string; seen: Set<string>; bump: () => void }>()((set) => ({
        token: disk.get('auth') ?? 'real-store',
        seen: new Set(['a']),
        bump: () => set({ token: 'fake-store', seen: new Set(['b']) }),
      }))
      store.subscribe((s) => void disk.set('auth', s.token))
      ;(store as unknown as { persist: unknown }).persist = { getOptions: () => ({}), hasHydrated: () => true }
      return { ...storeTools({ auth: store }), ...restoreTools(getTools) }
    }
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    const opts = { restore: false, extra: withSet } as const
    const first = await fakeApp(metro.metro, 'dev-1', { ...opts, loadId: 'load-1' })
    cleanups.push(() => first.ws.close())
    const daemon = await runSessionDaemon({ name: 'rl3', metro: metro.metro, idleMs: 0, healthMs: 0 })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession({ name: 'rl3', timeoutMs: 1000 })
    cleanups.push(bridge.close)
    await bridge.call('store.call', 'auth', 'bump')
    first.ws.close()
    const second = await fakeApp(metro.metro, 'dev-2', { ...opts, loadId: 'load-2' })
    cleanups.push(() => second.ws.close())
    const next = await bridge.timed('bridge.pending')
    expect(next.notice).toContain('not kept across reload')
    expect(next.notice).toContain('auth:seen')
    expect(next.notice).toContain('kept 1 undo')
  }, 15_000)

  const setup = async (name: string, extraOpts: Record<string, unknown> = {}, daemonOpts: Record<string, unknown> = {}) => {
    disk.clear()
    disk.set('kv:token', 'real')
    disk.set('auth', 'real-store')
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    const opts = { restore: false, extra: withStorage, ...extraOpts } as const
    const first = await fakeApp(metro.metro, 'dev-1', { ...opts, loadId: 'load-1' })
    cleanups.push(() => first.ws.close())
    const daemon = await runSessionDaemon({ name, metro: metro.metro, idleMs: 0, healthMs: 0, adoptRetryMs: 0, ...daemonOpts })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession({ name, timeoutMs: 1000 })
    cleanups.push(bridge.close)
    return { metro, opts, first, daemon, bridge }
  }

  test('the journal rides on the write reply, with no separate read', async () => {
    const { first, bridge } = await setup('rl-ride')
    const seen: string[] = []
    first.onCall = (t) => void seen.push(t)
    await bridge.call('mmkv.set', 'kv', 'token', 'fake')
    expect(seen).toEqual(['mmkv.set'])
  })

  test('a reload right after a write keeps its undo', async () => {
    const { metro, opts, first, daemon, bridge } = await setup('rl-race')
    let second: Awaited<ReturnType<typeof fakeApp>> | undefined
    // The old design read the journal in a second call, which a reload could answer empty.
    first.onCall = (t) => {
      if (t === 'bridge.journal') first.ws.close()
    }
    await bridge.call('mmkv.set', 'kv', 'token', 'fake')
    first.ws.close()
    second = await fakeApp(metro.metro, 'dev-2', { ...opts, loadId: 'load-2' })
    cleanups.push(() => second?.ws.close())
    const next = await bridge.timed('bridge.pending')
    expect(next.notice).toContain('kept 1 undo')
    await daemon.stop()
    expect(disk.get('kv:token')).toBe('real')
  }, 15_000)

  test('a call that fails after a reload carries the kept-undo notice in the same reply', async () => {
    const { metro, opts, first, bridge } = await setup('rl-notice')
    await bridge.call('mmkv.set', 'kv', 'token', 'fake')
    first.ws.close()
    const second = await fakeApp(metro.metro, 'dev-2', { ...opts, loadId: 'load-2' })
    cleanups.push(() => second.ws.close())
    const error = await bridge.call('demo.echo', 1).catch((e: unknown) => e as { notice?: string })
    expect(String((error as { notice?: string }).notice)).toContain('kept 1 undo')
  }, 15_000)

  test('stop right after a reload restores the journaled fakes', async () => {
    const { metro, opts, first, daemon, bridge } = await setup('rl-stop')
    await bridge.call('mmkv.set', 'kv', 'token', 'fake')
    first.ws.close()
    const second = await fakeApp(metro.metro, 'dev-2', { ...opts, loadId: 'load-2' })
    cleanups.push(() => second.ws.close())
    const stopped = await daemon.stop()
    expect(stopped).toMatchObject({ ok: true })
    expect(disk.get('kv:token')).toBe('real')
  }, 15_000)

  test('a write whose reply was lost to a reload says its undo is lost', async () => {
    const { metro, opts, first, bridge } = await setup('rl-lostwrite')
    first.onCall = (t) => t === 'mmkv.set' && first.ws.close()
    const error = await bridge.call('mmkv.set', 'kv', 'token', 'fake').catch((e: unknown) => e as { notice?: string })
    const second = await fakeApp(metro.metro, 'dev-2', { ...opts, loadId: 'load-2' })
    cleanups.push(() => second.ws.close())
    const again = await bridge.timed('bridge.pending')
    expect(`${(error as { notice?: string }).notice} ${again.notice}`).toContain('that undo may be lost')
  }, 15_000)

  test('an area that never becomes ready is tried three times, reported once, then dropped', async () => {
    const { metro, first, bridge, daemon } = await setup('rl-cap')
    await bridge.call('mmkv.set', 'kv', 'token', 'fake')
    first.ws.close()
    const second = await fakeApp(metro.metro, 'dev-2', {
      restore: false,
      loadId: 'load-2',
      extra: (g: () => Tools) => ({ ...mmkvTools({}), ...restoreTools(g) }),
    })
    cleanups.push(() => second.ws.close())
    const adopts: string[] = []
    second.onCall = (t) => t === 'bridge.adopt' && adopts.push(t)
    const notices: (string | undefined)[] = []
    for (let i = 0; i < 4; i++) notices.push((await bridge.timed('bridge.pending')).notice)
    expect(notices[0]).toContain('will retry: mmkv:kv (not ready)')
    expect(notices[1]).toBeUndefined()
    expect(notices[2]).toContain('could not re-arm after the reload: mmkv:kv')
    expect(notices[3]).toBeUndefined()
    expect(adopts.length).toBe(3)
    void daemon
  }, 20_000)

  test('a second reload keeps what was still waiting', async () => {
    const { metro, first, bridge, daemon } = await setup('rl-two')
    disk.set('kv2:k', 'orig2')
    // Load 1 has kv and kv2; load 2 only kv2; load 3 both.
    const mk = (names: string[]) => (g: () => Tools): Tools => {
      const all: Record<string, ReturnType<typeof mem>['kv']> = {}
      for (const n of names) {
        const pre = n === 'kv' ? 'kv:' : 'kv2:'
        all[n] = {
          getAllKeys: () => [...disk.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length)),
          getString: (k: string) => disk.get(pre + k),
          set: (k: string, v: string | number | boolean) => void disk.set(pre + k, String(v)),
          remove: (k: string) => disk.delete(pre + k),
        }
      }
      return { ...mmkvTools(all), ...restoreTools(g) }
    }
    first.ws.close()
    const one = await fakeApp(metro.metro, 'dev-1b', { restore: false, loadId: 'load-1b', extra: mk(['kv', 'kv2']) })
    cleanups.push(() => one.ws.close())
    await bridge.timed('bridge.pending')
    await bridge.call('mmkv.set', 'kv', 'token', 'fake')
    one.ws.close()
    const two = await fakeApp(metro.metro, 'dev-2', { restore: false, loadId: 'load-2', extra: mk(['kv2']) })
    cleanups.push(() => two.ws.close())
    await bridge.timed('bridge.pending')
    await bridge.call('mmkv.set', 'kv2', 'k', 'fake2')
    two.ws.close()
    const three = await fakeApp(metro.metro, 'dev-3', { restore: false, loadId: 'load-3', extra: mk(['kv', 'kv2']) })
    cleanups.push(() => three.ws.close())
    await daemon.stop()
    expect(disk.get('kv:token')).toBe('real')
    expect(disk.get('kv2:k')).toBe('orig2')
  }, 20_000)

  test('stop: a restore whose reply was lost is repeated only if something is still pending', async () => {
    for (const changed of [false, true]) {
      const { metro, daemon, first } = await setup(`rl-lost-restore-${changed}`, { restore: false }, { timeoutMs: 1000 })
      first.ws.close()
      const a = await fakeApp(metro.metro, 'dev-a', { dropOnce: ['bridge.restore'], loadId: 'load-1', extra: undefined })
      cleanups.push(() => a.ws.close())
      let b: Awaited<ReturnType<typeof fakeApp>> | undefined
      // The app comes back (same load) right after the restore cut the socket.
      a.onCall = (t) => {
        if (t !== 'bridge.restore') return
        void fakeApp(metro.metro, 'dev-b', { counted: ['bridge.restore'], loadId: 'load-1' }).then((x) => {
          b = x
          x.changed = changed
          cleanups.push(() => x.ws.close())
        })
      }
      const stopped = await daemon.stop()
      expect(stopped).toMatchObject({ ok: true })
      expect(b?.runs['bridge.restore']).toBe(changed ? 1 : undefined)
    }
  }, 40_000)

  test('a call without the session key cannot read or hand over the journal', async () => {
    const { first, metro } = await setup('rl-key')
    void first
    const { connect } = await import('../../index')
    const bridge = await connect({ metro: metro.metro, transport: 'expo', timeoutMs: 1000 })
    cleanups.push(() => bridge.close())
    await expect(bridge.call('bridge.adopt', {})).rejects.toThrow(/session's own use/)
    const tools = (await bridge.tools()).map((t: { name: string }) => t.name)
    expect(tools).not.toContain('bridge.adopt')
  }, 15_000)

  test('a value the app changed since is left alone and said so', async () => {
    disk.clear()
    disk.set('kv:token', 'real')
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    const opts = { restore: false, extra: withStorage } as const
    const first = await fakeApp(metro.metro, 'dev-1', { ...opts, loadId: 'load-1' })
    cleanups.push(() => first.ws.close())
    const daemon = await runSessionDaemon({ name: 'rl2', metro: metro.metro, idleMs: 0, healthMs: 0 })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession({ name: 'rl2', timeoutMs: 1000 })
    cleanups.push(bridge.close)
    await bridge.call('mmkv.set', 'kv', 'token', 'fake')
    first.ws.close()
    disk.set('kv:token', 'app-refreshed')
    const second = await fakeApp(metro.metro, 'dev-2', { ...opts, loadId: 'load-2' })
    cleanups.push(() => second.ws.close())
    const next = await bridge.timed('bridge.pending')
    expect(next.notice).toContain('left alone, the app changed them since: kv:token')
    await daemon.stop()
    expect(disk.get('kv:token')).toBe('app-refreshed')
  }, 15_000)

  // Not ready on its first adopt (waits out the hydration timeout), ready on the next.
  const lateStore = (getTools: () => Tools): Tools => {
    let asked = 0
    const auth = createStore<{ token: string }>()(() => ({ token: disk.get('auth') ?? 'real-store' }))
    auth.subscribe((s) => void disk.set('auth', s.token))
    ;(auth as unknown as { persist: unknown }).persist = {
      getOptions: () => ({}),
      hasHydrated: () => asked++ > 0,
      onFinishHydration: () => () => {},
    }
    return { ...storeTools({ auth }), ...restoreTools(getTools) }
  }

  test('an adopt that never answers but leaves the app alive is tried three times, then dropped', async () => {
    const { metro, first, bridge } = await setup('rl-slow', {}, { timeoutMs: 400, adoptTimeoutMs: 200 })
    await bridge.call('mmkv.set', 'kv', 'token', 'fake')
    first.ws.close()
    const second = await fakeApp(metro.metro, 'dev-2', {
      restore: false,
      loadId: 'load-2',
      extra: (g: () => Tools) => ({ ...mmkvTools({}), ...restoreTools(g), 'bridge.adopt': () => new Promise(() => {}) }),
    })
    cleanups.push(() => second.ws.close())
    let adopts = 0
    second.onCall = (t) => t === 'bridge.adopt' && void adopts++
    const notices: string[] = []
    for (let i = 0; i < 5; i++) notices.push(String((await bridge.timed('bridge.pending')).notice ?? ''))
    expect(notices.join(' ')).toContain('could not re-arm after the reload: mmkv:kv (timed out)')
    expect(adopts).toBe(3)
  }, 30_000)

  test('stop right after a reload retries a store that is still hydrating', async () => {
    disk.clear()
    disk.set('auth', 'real-store')
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    const opts = { restore: false, extra: lateStore } as const
    const first = await fakeApp(metro.metro, 'dev-1', { ...opts, loadId: 'load-1' })
    cleanups.push(() => first.ws.close())
    const daemon = await runSessionDaemon({ name: 'rl-late', metro: metro.metro, idleMs: 0, healthMs: 0, adoptRetryMs: 50 })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession({ name: 'rl-late', timeoutMs: 8000 })
    cleanups.push(bridge.close)
    await bridge.call('store.set', 'auth', { token: 'fake-store' })
    first.ws.close()
    const second = await fakeApp(metro.metro, 'dev-2', { ...opts, loadId: 'load-2' })
    cleanups.push(() => second.ws.close())
    const stopped = await daemon.stop()
    expect(stopped).toMatchObject({ ok: true })
    expect(disk.get('auth')).toBe('real-store')
  }, 30_000)

  test('a mid-session bridge.restore does not wait out the retry pause for the journal', async () => {
    disk.clear()
    disk.set('auth', 'real-store')
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    const opts = { restore: false, extra: lateStore } as const
    const first = await fakeApp(metro.metro, 'dev-1', { ...opts, loadId: 'load-1' })
    cleanups.push(() => first.ws.close())
    const daemon = await runSessionDaemon({ name: 'rl-mid', metro: metro.metro, idleMs: 0, healthMs: 0, adoptRetryMs: 60_000 })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession({ name: 'rl-mid', timeoutMs: 8000 })
    cleanups.push(bridge.close)
    await bridge.call('store.set', 'auth', { token: 'fake-store' })
    first.ws.close()
    const second = await fakeApp(metro.metro, 'dev-2', { ...opts, loadId: 'load-2' })
    cleanups.push(() => second.ws.close())
    await bridge.timed('bridge.pending')
    await bridge.call('bridge.restore')
    expect(disk.get('auth')).toBe('real-store')
  }, 30_000)

})
