import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'

import WebSocket from 'ws'

import { createRegistry } from '../../runtime/registry'
import type { Tools } from '../../runtime/types'
import { PLUGIN_NAME, PROTOCOL_VERSION } from '../../shared/protocol'
import { bigValue } from '../../client/__tests__/big-value'
import { startFakeMetro } from '../../client/__tests__/fake-metro'
import { connectSession } from '../../client/session/client'
import { runSessionDaemon } from '../../client/session/daemon'
import { mcpNames, startMcpServer } from '../server'

const PNG = 'iVBORw0KGgo='

let restores = 0

async function fakeApp(metro: string, deviceId: string, extra: Tools = {}) {
  const tools: Tools = {
    'demo.echo': (...args: unknown[]) => args,
    'demo.big': (bytes: number) => bigValue(bytes),
    'demo.fail': () => {
      throw new Error('it broke')
    },
    'screen.capture': () => ({ base64: `data:image/png;base64,${PNG}` }),
    'bridge.restore': () => {
      restores++
      return { undone: 1 }
    },
    ...extra,
  }
  const registry = createRegistry(() => tools, undefined, `load-${deviceId}`)
  const ws = new WebSocket(`ws://${metro}/expo-dev-plugins/broadcast`)
  await new Promise((r) => ws.once('open', r))
  const send = (method: string, payload: unknown) =>
    ws.send(JSON.stringify({ messageKey: { pluginName: PLUGIN_NAME, method }, payload }))
  ws.on('message', async (data) => {
    const { messageKey, payload } = JSON.parse(String(data))
    if (messageKey.pluginName !== PLUGIN_NAME) return
    if (messageKey.method === 'hello')
      send('hello:reply', {
        deviceId,
        name: 'Fake App',
        platform: 'ios',
        protocol: PROTOCOL_VERSION,
        loadId: `load-${deviceId}`,
        tools: registry.list(),
      })
    if (messageKey.method === 'call' && payload.to === deviceId)
      send('result', await registry.dispatch(payload, deviceId))
  })
  return ws
}

let dir = ''
const cleanups: Array<() => unknown> = []
beforeEach(() => {
  restores = 0
  dir = mkdtempSync(join(tmpdir(), 'ab-mcp-'))
  process.env.AGENT_BRIDGE_STATE_DIR = dir
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  delete process.env.AGENT_BRIDGE_STATE_DIR
  rmSync(dir, { recursive: true, force: true })
})

/** Fake Metro + app + a session daemon + an MCP server on in-memory pipes. */
async function setup(options: { pollMs?: number; short?: boolean } = {}) {
  const metro = await startFakeMetro({ expo: true })
  cleanups.push(metro.close)
  const app = await fakeApp(metro.metro, 'dev-1')
  cleanups.push(() => app.close())
  const daemon = await runSessionDaemon({
    name: 'mcp-test',
    metro: metro.metro,
    idleMs: 0,
    healthMs: options.pollMs ? 40 : 0,
    ...(options.short && { reloadWaitMs: 1500, attemptMs: 1500 }),
  })
  cleanups.push(() => daemon.stop(true))

  const input = new PassThrough()
  const output = new PassThrough()
  const server = startMcpServer({
    input,
    output,
    pollMs: options.pollMs ?? 0,
    connect: () => connectSession({ name: 'mcp-test', timeoutMs: options.short ? 500 : undefined }),
  })
  cleanups.push(() => server.close())

  const messages: any[] = []
  const waiters: Array<() => void> = []
  createInterface({ input: output }).on('line', (line) => {
    messages.push(JSON.parse(line))
    for (const w of waiters.splice(0)) w()
  })
  let seq = 0
  const wait = async (find: () => any, ms = 15000) => {
    const end = Date.now() + ms
    for (;;) {
      const hit = find()
      if (hit) return hit
      if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(messages)}`)
      await new Promise<void>((r) => {
        waiters.push(r)
        setTimeout(r, 50)
      })
    }
  }
  const request = async (method: string, params?: unknown) => {
    const id = ++seq
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return wait(() => messages.find((m) => m.id === id))
  }
  const call = (name: string, args?: unknown[], more: object = {}) =>
    request('tools/call', { name, arguments: { ...(args && { args }), ...more } })
  return { metro: metro.metro, app, daemon, input, server, messages, wait, request, call }
}

describe('mcpNames', () => {
  test('replaces dots, keeps names unique and within 64 characters', () => {
    const names = mcpNames([{ name: 'screen.snapshot' }, { name: 'screen_snapshot' }, { name: `a.${'b'.repeat(80)}` }])
    expect([...names.keys()].slice(0, 2)).toEqual(['screen_snapshot', 'screen_snapshot_2'])
    expect(names.get('screen_snapshot')).toBe('screen.snapshot')
    expect(names.get('screen_snapshot_2')).toBe('screen_snapshot')
    for (const k of names.keys()) expect(k.length).toBeLessThanOrEqual(64)
  })
})

describe('mcp server', () => {
  test('initializes, lists the app tools and calls them', async () => {
    const s = await setup()
    const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'agent-bridge' },
    })
    s.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    const list = (await s.request('tools/list')).result.tools as Array<{ name: string; title: string; inputSchema: any }>
    const echo = list.find((t) => t.name === 'demo_echo')
    expect(echo?.title).toBe('demo.echo')
    expect(echo?.inputSchema.properties.args.type).toBe('array')

    const res = (await s.call('demo_echo', ['hi', { n: 1 }])).result
    expect(res.isError).toBeUndefined()
    expect(JSON.parse(res.content[0].text)).toEqual(['hi', { n: 1 }])
    expect((await s.request('ping')).result).toEqual({})
    expect((await s.call('nope')).error.code).toBe(-32602)
    expect((await s.request('resources/list')).error.code).toBe(-32601)
  })

  test('a failing tool is an isError result with the app\'s text', async () => {
    const s = await setup()
    await s.request('tools/list')
    const res = (await s.call('demo_fail')).result
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('it broke')
    const bad = (await s.call('demo_echo', undefined, { args: 'x' })).result
    expect(bad.isError).toBe(true)
  })

  test('a result over 32 KB is a summary unless full is true', async () => {
    const s = await setup()
    await s.request('tools/list')
    const small = (await s.call('demo_big', [100_000])).result
    const summary = JSON.parse(small.content[0].text)
    expect(summary.resultTooLarge).toBe(true)
    expect(summary.hint).toContain('full: true')
    const full = (await s.call('demo_big', [100_000], { full: true })).result
    expect(full.content[0].text.length).toBeGreaterThan(100_000)
  })

  test('screen.capture base64 becomes an image block', async () => {
    const s = await setup()
    await s.request('tools/list')
    const res = (await s.call('screen_capture', [{ base64: true }])).result
    expect(res.content[0]).toEqual({ type: 'image', data: PNG, mimeType: 'image/png' })
  })

  test('an app reload: the notice comes back and a changed tool list is announced', async () => {
    const s = await setup({ pollMs: 40 })
    s.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    await s.request('tools/list')
    s.app.close()
    const next = await fakeApp(s.metro, 'dev-2', { 'demo.new': () => 'new' })
    cleanups.push(() => next.close())
    await s.wait(() => s.messages.find((m) => m.method === 'notifications/tools/list_changed'))
    const list = (await s.request('tools/list')).result.tools as Array<{ name: string }>
    expect(list.map((t) => t.name)).toContain('demo_new')
    expect(JSON.parse((await s.call('demo_new')).result.content[0].text)).toBe('new')
  })

  test('when the app goes away calls fail with isError and the server keeps serving', async () => {
    const s = await setup({ short: true })
    await s.request('tools/list')
    s.app.close()
    await new Promise((r) => setTimeout(r, 100))
    const gone = (await s.call('demo_echo', [1], {})).result
    expect(gone.isError).toBe(true)
    expect(gone.content[0].text.length).toBeGreaterThan(0)
    expect((await s.request('ping')).result).toEqual({})
    expect((await s.request('tools/list')).result.tools.length).toBeGreaterThan(0)
    const back = await fakeApp(s.metro, 'dev-3')
    cleanups.push(() => back.close())
    const ok = (await s.call('demo_echo', [2])).result
    expect(ok.isError).toBeUndefined()
    expect(JSON.parse(ok.content[0].text)).toEqual([2])
  })

  test('bad JSON gets a parse error and the server carries on', async () => {
    const s = await setup()
    s.input.write('not json\n')
    expect((await s.wait(() => s.messages.find((m) => m.error?.code === -32700))).id).toBeNull()
    expect((await s.request('ping')).result).toEqual({})
  })
})

describe('agent-bridge mcp', () => {
  test('starts its own session, speaks only JSON-RPC on stdout, restores on exit', async () => {
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    const app = await fakeApp(metro.metro, 'dev-1')
    cleanups.push(() => app.close())
    const child = spawn(process.execPath, ['src/cli.ts', 'mcp', '--metro', metro.metro], {
      env: { ...process.env, AGENT_BRIDGE_STATE_DIR: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise<number | null>((r) => child.once('exit', r))
    cleanups.push(() => child.kill())
    const replies: any[] = []
    createInterface({ input: child.stdout }).on('line', (l) => replies.push(JSON.parse(l)))
    const send = (id: number, method: string, params?: unknown) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    send(1, 'initialize', { protocolVersion: '2025-06-18' })
    send(2, 'tools/list')
    const until = async (f: () => unknown) => {
      for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 50))
    }
    await until(() => replies.find((r) => r.id === 2))
    expect(replies.find((r) => r.id === 2).result.tools.map((t: any) => t.name)).toContain('demo_echo')
    send(3, 'tools/call', { name: 'demo_echo', arguments: { args: [7] } })
    await until(() => replies.find((r) => r.id === 3))
    expect(JSON.parse(replies.find((r) => r.id === 3).result.content[0].text)).toEqual([7])
    child.stdin.end()
    expect(await exited).toBe(0)
    expect(restores).toBe(1)
  }, 20_000)
})
