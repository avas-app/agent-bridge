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
import { connectSession } from '../client'
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
  deviceId: string,
  options: { restore?: boolean } = {},
) {
  const app = { restores: 0, slow: 0, ws: undefined as unknown as WebSocket }
  const tools: Tools = {
    'demo.echo': (...args: unknown[]) => args,
    'demo.slow': async () => {
      app.slow++
      await new Promise((r) => setTimeout(r, 400))
    },
    ...(options.restore === false
      ? {}
      : {
          'bridge.restore': () => {
            app.restores++
            return { undone: 2 }
          },
        }),
  }
  const registry = createRegistry(() => ({
    ...bridgeTools(() => registry.list()),
    ...tools,
  }))
  const info = (): DeviceInfo => ({
    deviceId,
    name: 'Fake App',
    platform: 'ios',
    protocol: PROTOCOL_VERSION,
    tools: registry.list(),
  })
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
    if (messageKey.method === 'hello') send('hello:reply', info())
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

async function setup(options: { restore?: boolean } = {}) {
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
