import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import WebSocket from 'ws'

import { createRegistry } from '../../../runtime/registry'
import { bridgeTools } from '../../../runtime/tools/bridge'
import type { Tools } from '../../../runtime/types'
import {
  type DeviceInfo,
  PLUGIN_NAME,
  PROTOCOL_VERSION,
} from '../../../shared/protocol'
import { startFakeMetro } from '../../__tests__/fake-metro'
import { AgentBridgeCallError } from '../../index'
import { connectSession, sessionRequest } from '../client'
import { runSessionDaemon } from '../daemon'
import {
  isAlive,
  listSessions,
  parseDuration,
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
  } = {},
) {
  let deviceId = firstId
  let loadId = options.loadId ?? 'load-1'
  const app = {
    restores: 0,
    slow: 0,
    reloads: 0,
    changed: false,
    ws: undefined as unknown as WebSocket,
    /** The runtime restarts on this socket. A new device id is announced, as Expo does. */
    reload: (id: string, load = loadId) => {
      const announce = id !== deviceId
      deviceId = id
      loadId = load
      registry = make()
      if (announce) send('hello:reply', info())
    },
  }
  const tools: Tools = {
    'demo.echo': (...args: unknown[]) => args,
    'demo.set': () => {
      app.changed = true
    },
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
  type Registry = ReturnType<typeof createRegistry>
  let registry: Registry
  const make = (): Registry =>
    createRegistry(
      () => ({ ...bridgeTools(() => registry.list()), ...tools }),
      undefined,
      loadId,
    )
  registry = make()
  const info = (): DeviceInfo => ({
    deviceId,
    name: 'Fake App',
    platform: 'ios',
    protocol: PROTOCOL_VERSION,
    loadId,
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
const cleanups: Array<() => unknown> = []
beforeEach(() => {
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
  return { metro: metro.metro, app }
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
    const timed = await bridge.timed('demo.echo', 'hi', { n: 1 })
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
    expect(await bridge.call('demo.echo', 1)).toEqual([1])
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
    expect(await bridge.call('demo.echo', 1)).toEqual([1])

    // A reload: same app, new device id.
    app.ws.close()
    const reloaded = await fakeApp(metro, 'dev-2')
    cleanups.push(() => reloaded.ws.close())
    expect(await bridge.call('demo.echo', 2)).toEqual([2])
    expect(listSessions()[0]?.device.deviceId).toBe('dev-2')

    reloaded.ws.close()
    await expect(bridge.call('demo.echo', 3)).rejects.toThrow('The app is gone')
  }, 15_000)

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
  const LOST = 'app reloaded; 1 pending restore lost: demo'

  test('reports the restores a reload lost, once in the next call and again on stop', async () => {
    const { metro, app, bridge } = await session('lost')
    await bridge.call('demo.set')
    expect((await bridge.timed('demo.echo', 1)).notice).toBeUndefined()

    // The old app's socket goes; a new runtime with a new load id comes up.
    app.ws.close()
    const reloaded = await fakeApp(metro, 'dev-2', { loadId: 'load-2' })
    cleanups.push(() => reloaded.ws.close())
    const next = await bridge.timed('demo.echo', 2)
    expect(next.value).toEqual([2])
    expect(next.notice).toBe(LOST)
    expect((await bridge.timed('demo.echo', 3)).notice).toBeUndefined()
    expect(readFileSync(sessionFiles('lost', dir).log, 'utf8')).toContain(
      `warning: ${LOST}`,
    )

    const stopped = await sessionRequest(listSessions()[0]!, { op: 'stop' })
    expect(stopped.notice).toBe(LOST)
    expect(reloaded.restores).toBe(1)
  }, 15_000)

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
    const next = await bridge.timed('demo.echo', 2)
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(next.notice).toBe(LOST)
    expect(listSessions()[0]?.device.deviceId).toBe('dev-2')
  }, 15_000)

  test('Fast Refresh (new device id, same load id) is not a reload', async () => {
    const { app, bridge } = await session('refresh', { timeoutMs: 8000 })
    await bridge.call('demo.set')
    app.reload('dev-2')
    const next = await bridge.timed('demo.echo', 2)
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
    const next = await bridge.timed('demo.echo', 2)
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
      expect((await bridge.timed('demo.echo', i)).notice).toBeUndefined()
    app.reload('dev-1', 'load-2')
    expect((await bridge.timed('demo.echo', 4)).notice).toBe(
      'app reloaded; 0 pending restores lost',
    )
  }, 15_000)

  test('a direct demo.restore clears its area from the lost list', async () => {
    const { app, bridge } = await session('cleared')
    await bridge.call('demo.set')
    await bridge.call('demo.restore')
    app.reload('dev-1', 'load-2')
    expect((await bridge.timed('demo.echo', 1)).notice).toBe(
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
      const next = await bridge.timed('demo.echo', 1)
      expect(next.value).toEqual([1])
      expect(next.notice).toBe(LOST)
      expect(app.reloads).toBe(1)
    }, 20_000)

    test('the call after it waits for the bridge to come back', async () => {
      const { metro, app, bridge } = await session('wait')
      await bridge.call('demo.set')
      expect(await bridge.call('app.reload')).toEqual({ reloading: true })
      comeBack(metro, app.ws)
      const next = await bridge.timed('demo.echo', 1)
      expect(next.notice).toBe(LOST)
    }, 20_000)

    test('says the app is reloading when the bridge never comes back', async () => {
      const { app, bridge } = await session('gone', { reloadWaitMs: 1000 })
      expect(await bridge.call('app.reload')).toEqual({ reloading: true })
      app.ws.close()
      await expect(bridge.call('demo.echo', 1)).rejects.toThrow(
        'The app is reloading; its bridge isn\'t ready yet',
      )
    }, 20_000)
  })

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
