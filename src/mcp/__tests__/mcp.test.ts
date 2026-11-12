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
import { connectSession, SessionLinkError, sessionRequest } from '../../client/session/client'
import { runSessionDaemon } from '../../client/session/daemon'
import { listSessions } from '../../client/session/state'
import { createConnector } from '../run'
import { type McpOptions, mcpNames, startMcpServer } from '../server'

const PNG = 'iVBORw0KGgo='
const JPEG = '/9j/4AAQSkZJRg=='

let restores = 0

async function fakeApp(metro: string, deviceId: string, extra: Tools = {}) {
  const tools: Tools = {
    'demo.echo': (...args: unknown[]) => args,
    'demo.big': (bytes: number) => bigValue(bytes),
    'demo.fail': () => {
      throw new Error('it broke')
    },
    'screen.capture': (kind?: string) =>
      kind === 'jpeg'
        ? { base64: `data:image/jpeg;base64,${JPEG}` }
        : kind === 'text'
          ? { base64: 'aGVsbG8gd29ybGQ=', name: 'notes.txt' }
          : { base64: `data:image/png;base64,${PNG}` },
    'demo.file': () => ({ base64: 'aGVsbG8gd29ybGQ=', name: 'notes.txt' }),
    'demo.slow': () => new Promise((r) => setTimeout(() => r('slow'), 400)),
    'bridge.restore': () => {
      restores++
      return { undone: 1 }
    },
    ...extra,
  }
  const registry = createRegistry(() => tools, undefined, `load-${deviceId}`)
  const ws = new WebSocket(`ws://${metro}/expo-dev-plugins/broadcast`)
  ws.on('error', () => {})
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

  const rig = serve({
    pollMs: options.pollMs ?? 0,
    connect: () => connectSession({ name: 'mcp-test', timeoutMs: options.short ? 500 : undefined }),
  })
  return { metro: metro.metro, app, daemon, ...rig }
}

/** An MCP server on in-memory pipes, plus helpers to talk to it. */
function serve(config: Omit<McpOptions, 'input' | 'output'>) {
  const input = new PassThrough()
  const output = new PassThrough()
  const server = startMcpServer({ input, output, ...config })
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
  const notify = (method: string, params?: unknown) =>
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  return { input, server, messages, wait, request, call, notify }
}

describe('mcpNames', () => {
  test('replaces dots, keeps names unique and within 64 characters', () => {
    const names = mcpNames([{ name: 'screen.snapshot' }, { name: 'screen_snapshot' }, { name: `a.${'b'.repeat(80)}` }])
    expect([...names]).toEqual([
      ['a_' + 'b'.repeat(58), `a.${'b'.repeat(80)}`],
      ['screen_snapshot', 'screen.snapshot'],
      ['screen_snapshot_2', 'screen_snapshot'],
    ])
  })

  test('a clash is numbered the same way whatever order the app lists the tools in', () => {
    const a = mcpNames([{ name: 'a.b' }, { name: 'a_b' }, { name: 'a-b' }])
    const b = mcpNames([{ name: 'a_b' }, { name: 'a-b' }, { name: 'a.b' }])
    expect([...a].sort()).toEqual([...b].sort())
    expect(a.get('a_b')).toBe('a.b')
    expect(a.get('a_b_2')).toBe('a_b')
  })

  test('a reserved name is never given to an app tool', () => {
    expect(mcpNames([{ name: 'agent_bridge.status' }], ['agent_bridge_status']).get('agent_bridge_status_2')).toBe('agent_bridge.status')
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
    const after = (await s.call('demo_new')).result
    expect(JSON.parse(after.content[0].text)).toBe('new')
    expect(after.content.map((c: any) => c.text).join('\n')).toMatch(/Warning: .*reload/i)
  })

  test('when the app goes away calls fail with isError, naming the problem, and the server keeps serving', async () => {
    const s = await setup({ short: true })
    await s.request('tools/list')
    s.app.close()
    await new Promise((r) => setTimeout(r, 100))
    const gone = (await s.call('demo_echo', [1], {})).result
    expect(gone.isError).toBe(true)
    expect(gone.content[0].text).toMatch(/app|reload|connect|session/i)
    expect((await s.request('ping')).result).toEqual({})
    const status = JSON.parse((await s.call('agent_bridge_status')).result.content[0].text)
    expect(status).toBeDefined()
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
    const stdout: string[] = []
    createInterface({ input: child.stdout }).on('line', (l) => {
      stdout.push(l)
      replies.push(JSON.parse(l))
    })
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
    send(4, 'tools/call', { name: 'demo_fail' })
    send(5, 'tools/call', { name: 'no_such_tool' })
    await until(() => replies.find((r) => r.id === 5))
    child.stdin.end()
    expect(await exited).toBe(0)
    expect(restores).toBe(1)
    expect(stdout.length).toBeGreaterThanOrEqual(5)
    for (const line of stdout) expect(JSON.parse(line).jsonrpc).toBe('2.0')
  }, 20_000)
})


const echoBridge = (over: Record<string, unknown> = {}) =>
  ({
    transport: 'x',
    device: { deviceId: 'd1', name: 'App', platform: 'ios', protocol: 1, tools: [] },
    tools: () => [{ name: 'a.b' }],
    timed: async () => ({ value: 1, ms: 1, logs: [] }),
    call: async () => 1,
    close: () => {},
    ...over,
  }) as any

describe('late app', () => {
  test('an app that connects after the first tools/list is announced and listed; failures are logged once', async () => {
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    const logged: string[] = []
    const s = serve({
      pollMs: 40,
      log: (l) => logged.push(l),
      connect: () => connectSession({ name: 'late' }),
    })
    await s.request('initialize', { protocolVersion: '2025-06-18' })
    s.notify('notifications/initialized')
    const first = (await s.request('tools/list')).result.tools as Array<{ name: string }>
    expect(first.map((t) => t.name)).toEqual(['agent_bridge_status'])
    const down = JSON.parse((await s.call('agent_bridge_status')).result.content[0].text)
    expect(down.connected).toBe(false)
    expect(down.lastError).toMatch(/session/i)
    await new Promise((r) => setTimeout(r, 200))
    expect(logged.length).toBe(1)

    const app = await fakeApp(metro.metro, 'dev-1')
    cleanups.push(() => app.close())
    const daemon = await runSessionDaemon({ name: 'late', metro: metro.metro, idleMs: 0, healthMs: 0 })
    cleanups.push(() => daemon.stop(true))
    await s.wait(() => s.messages.find((m) => m.method === 'notifications/tools/list_changed'))
    const list = (await s.request('tools/list')).result.tools as Array<{ name: string }>
    expect(list.map((t) => t.name)).toContain('demo_echo')
    const up = JSON.parse((await s.call('agent_bridge_status')).result.content[0].text)
    expect(up).toMatchObject({ connected: true, app: { deviceId: 'dev-1' } })
    expect(s.messages.filter((m) => m.method === 'notifications/tools/list_changed').length).toBe(1)
  }, 20_000)
})

describe('errors', () => {
  test('an error that is not a lost socket is passed through and keeps the connection', async () => {
    let connects = 0
    const s = serve({
      connect: async () => {
        connects++
        return echoBridge({
          timed: async () => {
            throw new Error('a.b: the app disconnected; it may or may not have run')
          },
        })
      },
    })
    await s.request('tools/list')
    const res = (await s.call('a_b')).result
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toBe('a.b: the app disconnected; it may or may not have run')
    await s.call('a_b')
    expect(connects).toBe(1)
  })

  test('a closed socket says the call may not have run and reconnects on the next call', async () => {
    let connects = 0
    const s = serve({
      connect: async () => {
        connects++
        return echoBridge({
          timed: async () => {
            throw new SessionLinkError('Session "x" closed the connection')
          },
        })
      },
    })
    await s.request('tools/list')
    const res = (await s.call('a_b')).result
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('may or may not have run')
    await s.call('a_b')
    expect(connects).toBe(2)
  })

  test('a real session whose app reloaded mid-call gives the session\'s own text', async () => {
    const s = await setup({ short: true })
    await s.request('tools/list')
    const slow = s.call('demo_slow')
    await new Promise((r) => setTimeout(r, 100))
    s.app.close()
    const res = (await slow).result
    expect(res.isError).toBe(true)
    expect(res.content[0].text).not.toContain('connection to the app was lost')
  }, 20_000)
})

describe('images', () => {
  test('only screen.capture makes images, and a jpeg keeps its type', async () => {
    const s = await setup()
    await s.request('tools/list')
    const jpeg = (await s.call('screen_capture', ['jpeg'])).result
    expect(jpeg.content[0]).toEqual({ type: 'image', data: JPEG, mimeType: 'image/jpeg' })
    const notImage = (await s.call('screen_capture', ['text'])).result
    expect(notImage.content[0].type).toBe('text')
    expect(notImage.content[0].text).toContain('aGVsbG8gd29ybGQ=')
    const file = (await s.call('demo_file')).result
    expect(file.content.every((c: any) => c.type === 'text')).toBe(true)
    expect(file.content[0].text).toContain('notes.txt')
  })
})

describe('protocol', () => {
  test('replies to a response are ignored, id-less requests get no reply, 2025-03-26 is answered with a version we speak', async () => {
    const s = await setup()
    const init = await s.request('initialize', { protocolVersion: '2025-03-26' })
    expect(init.result.protocolVersion).toBe('2025-06-18')
    s.input.write('{"jsonrpc":"2.0","id":900,"result":{}}\n')
    s.input.write('{"jsonrpc":"2.0","method":"tools/list"}\n')
    s.input.write('{"jsonrpc":"2.0","method":"initialize","params":{}}\n')
    expect((await s.request('ping')).result).toEqual({})
    await new Promise((r) => setTimeout(r, 200))
    expect(s.messages.filter((m) => m.id === 900 || m.id === null || m.id === undefined)).toEqual([])
  })

  test('a batch is an invalid request', async () => {
    const s = await setup()
    s.input.write('[{"jsonrpc":"2.0","id":5,"method":"ping"}]\n')
    expect((await s.wait(() => s.messages.find((m) => m.error?.code === -32600))).id).toBeNull()
  })

  test('a cancelled call gets no reply and the server carries on', async () => {
    const s = await setup()
    await s.request('tools/list')
    s.input.write('{"jsonrpc":"2.0","id":77,"method":"tools/call","params":{"name":"demo_slow"}}\n')
    await new Promise((r) => setTimeout(r, 50))
    s.notify('notifications/cancelled', { requestId: 77 })
    expect((await s.request('ping')).result).toEqual({})
    await new Promise((r) => setTimeout(r, 600))
    expect(s.messages.find((m) => m.id === 77)).toBeUndefined()
  })
})

describe('connector', () => {
  const noFlags = {} as any
  const opts = (metro: string, device?: string) => ({ metro, device, timeoutMs: 3000 }) as any
  const apps = async (metro: string, ...ids: string[]) => {
    for (const id of ids) {
      const app = await fakeApp(metro, id)
      cleanups.push(() => app.close())
    }
  }

  test('after `session stop` the next call says the session stopped, then a new one is used', async () => {
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    const app = await fakeApp(metro.metro, 'dev-1')
    cleanups.push(() => app.close())
    const c = createConnector(noFlags, opts(metro.metro))
    cleanups.push(() => c.stop())
    const s = serve({ pollMs: 0, connect: c.connect, takeNotice: c.takeNotice })
    await s.request('tools/list')
    expect((await s.call('demo_echo', [1])).result.isError).toBeUndefined()
    const own = listSessions().find((x) => x.name === `mcp-${process.pid}`)!
    await sessionRequest(own, { op: 'stop' })
    await new Promise((r) => setTimeout(r, 100))
    const first = (await s.call('demo_echo', [2])).result
    expect(first.isError).toBe(true)
    expect(first.content[0].text).toMatch(/stopped/)
    const again = (await s.call('demo_echo', [3])).result
    expect(again.isError).toBeUndefined()
    expect(JSON.parse(again.content[0].text)).toEqual([3])
  }, 30_000)

  test('a second session in the project does not break a server that has its own', async () => {
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    await apps(metro.metro, 'dev-1', 'dev-2')
    const c = createConnector(noFlags, opts(metro.metro, 'dev-1'))
    cleanups.push(() => c.stop())
    const first = await c.connect()
    first.close()
    const other = await runSessionDaemon({ name: 'default', metro: metro.metro, device: 'dev-2', idleMs: 0, healthMs: 0 })
    cleanups.push(() => other.stop(true))
    const next = await c.connect()
    expect((next as any).session.name).toBe(`mcp-${process.pid}`)
    next.close()
  }, 20_000)

  test('it attaches to the project\'s session, keeps that one when another appears, and never takes another server\'s mcp session', async () => {
    const metro = await startFakeMetro({ expo: true })
    cleanups.push(metro.close)
    await apps(metro.metro, 'dev-1', 'dev-2', 'dev-3')
    const theirs = await runSessionDaemon({ name: 'mcp-999999', metro: metro.metro, device: 'dev-1', idleMs: 0, healthMs: 0 })
    cleanups.push(() => theirs.stop(true))
    const mine = await runSessionDaemon({ name: 'default', metro: metro.metro, device: 'dev-2', idleMs: 0, healthMs: 0 })
    cleanups.push(() => mine.stop(true))
    const c = createConnector(noFlags, opts(metro.metro))
    cleanups.push(() => c.stop())
    const a = await c.connect()
    expect((a as any).session.name).toBe('default')
    a.close()
    const extra = await runSessionDaemon({ name: 'third', metro: metro.metro, device: 'dev-3', idleMs: 0, healthMs: 0 })
    cleanups.push(() => extra.stop(true))
    const b = await c.connect()
    expect((b as any).session.name).toBe('default')
    b.close()
    await mine.stop(true)
    expect(c.takeNotice()).toBeUndefined()
    const next = await c.connect().catch((e) => e)
    expect(c.takeNotice()).toMatch(/"default".*stopped/)
    if (!(next instanceof Error)) next.close()
  }, 30_000)
})
