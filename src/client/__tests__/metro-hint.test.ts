import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import WebSocket from 'ws'

import { PLUGIN_NAME, PROTOCOL_VERSION } from '../../shared/protocol'
import { connect } from '../index'
import { assertListening, isRefused, probe } from '../metro-hint'
import { sessionFiles, writePrivate } from '../session/state'
import { startFakeMetro } from './fake-metro'

const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

/** A port nothing listens on: bound once, then let go. */
async function unusedPort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise((r) => server.close(r))
  return port
}

/** Metro's /status and /json/list, counting the /status probes. */
async function fakeStatus(apps: string[]) {
  const hits = { status: 0 }
  const server = createServer((req, res) => {
    if (req.url === '/status') {
      hits.status++
      res.end('packager-status:running')
    } else if (req.url === '/json/list') {
      res.end(JSON.stringify(apps.map((title) => ({ title }))))
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  const port = await listen(server)
  cleanups.push(() => new Promise((r) => server.close(r)))
  return { port, metro: `127.0.0.1:${port}`, hits }
}

const cleanups: Array<() => unknown> = []
const saved = { ...probe, env: process.env.AGENT_BRIDGE_STATE_DIR }
let stateDir = ''
beforeEach(() => {
  // No real sessions or Metro servers on this machine leak into the hint.
  stateDir = mkdtempSync(join(tmpdir(), 'ab-hint-'))
  process.env.AGENT_BRIDGE_STATE_DIR = stateDir
  probe.ports = []
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  Object.assign(probe, { ports: saved.ports })
  if (saved.env === undefined) delete process.env.AGENT_BRIDGE_STATE_DIR
  else process.env.AGENT_BRIDGE_STATE_DIR = saved.env
  rmSync(stateDir, { recursive: true, force: true })
})

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a failure')
    },
    (error: Error) => error.message,
  )

describe('connection refused', () => {
  test('names the Metro found on another port, with its app', async () => {
    const other = await fakeStatus(['Sprout (iPhone 16)'])
    probe.ports = [other.port]
    const port = await unusedPort()
    const message = await failure(connect({ metro: `127.0.0.1:${port}` }))
    expect(message).toBe(
      `Nothing is listening on 127.0.0.1:${port}. Metro is running on ${other.metro} (app: Sprout (iPhone 16)). Pass --metro ${other.metro} or set AGENT_BRIDGE_METRO=${other.metro}.`,
    )
  })

  test('lists several, and works for one transport alone', async () => {
    const a = await fakeStatus([])
    const b = await fakeStatus(['One', 'Two'])
    probe.ports = [a.port, b.port]
    const port = await unusedPort()
    const message = await failure(
      connect({ metro: `127.0.0.1:${port}`, transport: 'cdp' }),
    )
    expect(message).toContain(`${a.metro} (no app connected); ${b.metro} (apps: One, Two)`)
    expect(message).toContain('Pass --metro <host:port>')
  })

  test('finds the Metro of a running session outside the port range', async () => {
    const other = await fakeStatus(['Sprout'])
    writePrivate(
      sessionFiles('s1', stateDir).state,
      JSON.stringify({ name: 's1', pid: process.pid, metro: other.metro }),
    )
    const port = await unusedPort()
    const message = await failure(connect({ metro: `127.0.0.1:${port}` }))
    expect(message).toContain(`Metro is running on ${other.metro} (app: Sprout)`)
  })

  test('says when nothing was found, and how to set the address', async () => {
    const port = await unusedPort()
    const message = await failure(
      connect({ metro: `127.0.0.1:${port}`, transport: 'expo' }),
    )
    expect(message).toBe(
      `Nothing is listening on 127.0.0.1:${port}, and no Metro answered on 127.0.0.1 ports 8081-8090 or 8100-8199. Start Metro, or if it runs elsewhere, pass --metro <host:port> or set AGENT_BRIDGE_METRO=<host:port>.`,
    )
  })

  test('a probe that hangs gives up within the budget', async () => {
    const held: Array<{ destroy: () => void }> = []
    const hang = createServer((req) => held.push(req.socket))
    const port = await listen(hang)
    cleanups.push(() => {
      for (const s of held) s.destroy()
      return new Promise((r) => hang.close(r))
    })
    probe.ports = [port]
    const t0 = performance.now()
    await failure(connect({ metro: `127.0.0.1:${await unusedPort()}` }))
    expect(performance.now() - t0).toBeLessThan(1500)
  })

  test('devices: an empty list on a refused address throws the hint', async () => {
    const port = await unusedPort()
    expect(await failure(assertListening(`127.0.0.1:${port}`))).toStartWith(
      `Nothing is listening on 127.0.0.1:${port}`,
    )
    const up = await fakeStatus([])
    await assertListening(up.metro)
  })

  test('isRefused reads node and bun errors, and causes', () => {
    expect(isRefused(new Error('connect ECONNREFUSED 127.0.0.1:1'))).toBe(true)
    const cause = Object.assign(new Error('x'), { code: 'ConnectionRefused' })
    expect(isRefused(new TypeError('fetch failed', { cause }))).toBe(true)
    expect(isRefused(new Error('No app is connected to Metro.'))).toBe(false)
  })
})

describe('no app', () => {
  test('gives the likely causes and other Metro servers with apps', async () => {
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    const empty = await fakeStatus([])
    const other = await fakeStatus(['Sprout'])
    probe.ports = [empty.port, other.port, metro.port]
    const message = await failure(
      connect({ metro: metro.metro, transport: 'expo', device: 'sprout' }),
    )
    expect(message).toBe(
      `No app matches "sprout". Connected: none\nLikely: the app isn't open or hasn't reloaded since the bridge was mounted, it uses another Metro, or --device "sprout" doesn't match. Metro is running on ${other.metro} (app: Sprout). Pass --metro ${other.metro} or set AGENT_BRIDGE_METRO=${other.metro}.`,
    )
  })
})

test('a working connection never probes', async () => {
  const metro = await startFakeMetro({ expo: true })
  cleanups.push(metro.close)
  const watcher = await fakeStatus([])
  probe.ports = [watcher.port, metro.port]
  const app = new WebSocket(`ws://${metro.metro}/expo-dev-plugins/broadcast`)
  cleanups.push(() => app.close())
  await new Promise((r) => app.once('open', r))
  app.on('message', (data) => {
    const { messageKey } = JSON.parse(String(data))
    if (messageKey.method !== 'hello') return
    app.send(
      JSON.stringify({
        messageKey: { pluginName: PLUGIN_NAME, method: 'hello:reply' },
        payload: {
          deviceId: 'd1',
          name: 'Fake',
          platform: 'ios',
          protocol: PROTOCOL_VERSION,
          tools: [],
        },
      }),
    )
  })
  const bridge = await connect({ metro: metro.metro, transport: 'expo' })
  bridge.close()
  expect(bridge.device.name).toBe('Fake')
  expect(watcher.hits.status).toBe(0)
})
