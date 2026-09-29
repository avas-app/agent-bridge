import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Readable } from 'node:stream'

import WebSocket from 'ws'

import { createRegistry } from '../../runtime/registry'
import { bridgeTools } from '../../runtime/tools/bridge'
import type { Tools } from '../../runtime/types'
import {
  type DeviceInfo,
  PLUGIN_NAME,
  PROTOCOL_VERSION,
} from '../../shared/protocol'
import { runSessionDaemon } from '../session/daemon'
import { connectSession } from '../session/client'
import { parseBatchLine, parseCallArgs, runBatch } from '../batch'
import { type AgentBridge, connect } from '../index'
import {
  DOT_COMMANDS,
  HISTORY_LIMIT,
  complete,
  loadHistory,
  runRepl,
  saveHistory,
} from '../repl'
import { bigValue } from './big-value'
import { startFakeMetro } from './fake-metro'

let dir = ''
const cleanups: Array<() => unknown> = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-batch-'))
  process.env.AGENT_BRIDGE_STATE_DIR = dir
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  delete process.env.AGENT_BRIDGE_STATE_DIR
  rmSync(dir, { recursive: true, force: true })
})

/** An app on Expo's broadcast socket. */
async function setup() {
  const metro = await startFakeMetro({ expo: true })
  cleanups.push(metro.close)
  const app = { calls: [] as string[], restores: 0 }
  const tools: Tools = {
    'demo.echo': (...args: unknown[]) => {
      app.calls.push('demo.echo')
      return args
    },
    'demo.fail': () => {
      throw new Error('boom')
    },
    'demo.big': (bytes: number) => bigValue(bytes),
    'bridge.pending': () => ({ demo: true }),
    'bridge.restore': () => {
      app.restores++
      return { undone: 1 }
    },
  }
  const registry = createRegistry(() => ({
    ...bridgeTools(() => registry.list()),
    ...tools,
  }))
  const info = (): DeviceInfo => ({
    deviceId: 'dev-1',
    name: 'Fake App',
    platform: 'ios',
    protocol: PROTOCOL_VERSION,
    tools: registry.list(),
  })
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
    if (messageKey.method === 'hello') send('hello:reply', info())
    if (messageKey.method === 'call')
      send('result', await registry.dispatch(payload, 'dev-1'))
  })
  return { metro: metro.metro, app }
}

const lines = (...text: string[]) => Readable.from([`${text.join('\n')}\n`])

async function batch(
  bridge: Pick<AgentBridge, 'timed'>,
  input: string[],
  options: Parameters<typeof runBatch>[2] = {},
) {
  const out: Array<Record<string, unknown>> = []
  const result = await runBatch(bridge, lines(...input), {
    ...options,
    write: (line) => out.push(JSON.parse(line)),
  })
  return { out, ...result }
}

describe('parsing', () => {
  test('parseCallArgs: an array is the list, other JSON one argument, text a string', () => {
    expect(parseCallArgs(undefined)).toEqual([])
    expect(parseCallArgs('["a",{"b":1}]')).toEqual(['a', { b: 1 }])
    expect(parseCallArgs('{"b":1}')).toEqual([{ b: 1 }])
    expect(parseCallArgs('7')).toEqual([7])
    expect(parseCallArgs('Save changes')).toEqual(['Save changes'])
  })

  test('parseBatchLine: tool and args, blanks and comments skipped', () => {
    expect(parseBatchLine('demo.echo')).toEqual({ tool: 'demo.echo', args: [] })
    expect(parseBatchLine('  demo.echo   ["a", 2] ')).toEqual({
      tool: 'demo.echo',
      args: ['a', 2],
    })
    expect(parseBatchLine('screen.press Save changes')).toEqual({
      tool: 'screen.press',
      args: ['Save changes'],
    })
    expect(parseBatchLine('store.set {"a":1}')).toEqual({
      tool: 'store.set',
      args: [{ a: 1 }],
    })
    expect(parseBatchLine('')).toBeNull()
    expect(parseBatchLine('   ')).toBeNull()
    expect(parseBatchLine('# demo.echo 1')).toBeNull()
  })
})

describe('call --batch', () => {
  test('one JSON line per call over one direct connection', async () => {
    const { metro } = await setup()
    const bridge = await connect({ metro })
    cleanups.push(bridge.close)
    const { out, calls, failed } = await batch(bridge, [
      '# a comment',
      '',
      'demo.echo ["a", {"n":1}]',
      'demo.fail',
      'nope.tool',
      'demo.echo 5',
    ])
    expect(calls).toBe(4)
    expect(failed).toBe(2)
    expect(out.map((o) => [o.tool, o.ok])).toEqual([
      ['demo.echo', true],
      ['demo.fail', false],
      ['nope.tool', false],
      ['demo.echo', true],
    ])
    expect(out[0]).toMatchObject({ value: ['a', { n: 1 }] })
    expect(typeof out[0]?.ms).toBe('number')
    expect(out[1]?.error).toContain('boom')
    expect(out[2]?.error).toContain('Unknown tool')
    expect(out[3]?.value).toEqual([5])
  })

  test('--stop-on-error stops after the first failure', async () => {
    const { metro, app } = await setup()
    const bridge = await connect({ metro })
    cleanups.push(bridge.close)
    const { out, failed } = await batch(
      bridge,
      ['demo.echo 1', 'demo.fail', 'demo.echo 2'],
      { stopOnError: true },
    )
    expect(out.map((o) => o.ok)).toEqual([true, false])
    expect(failed).toBe(1)
    expect(app.calls).toEqual(['demo.echo'])
  })

  test('goes through a running session the same way', async () => {
    const { metro, app } = await setup()
    const daemon = await runSessionDaemon({
      name: 'batch',
      metro,
      idleMs: 0,
      healthMs: 0,
    })
    cleanups.push(() => daemon.stop(true))
    const bridge = await connectSession({ metro })
    cleanups.push(bridge.close)
    const { out, failed } = await batch(bridge, ['demo.echo x', 'demo.fail'])
    expect(out[0]).toMatchObject({ tool: 'demo.echo', ok: true, value: ['x'] })
    expect(out[1]).toMatchObject({ ok: false })
    expect(failed).toBe(1)
    expect(app.calls).toEqual(['demo.echo'])
  })

  test('big values are summarised, --full prints them, outDir writes a file per call', async () => {
    const { metro } = await setup()
    const bridge = await connect({ metro })
    cleanups.push(bridge.close)
    const big = ['demo.big 100000']
    expect((await batch(bridge, big)).out[0]?.value).toMatchObject({
      resultTooLarge: true,
    })
    expect((await batch(bridge, big, { full: true })).out[0]?.value).toEqual(
      bigValue(100_000),
    )
    const outDir = join(dir, 'out', 'nested')
    const { out } = await batch(bridge, ['demo.echo 1', 'demo.big 100000'], {
      outDir,
    })
    expect(out[0]?.value).toMatchObject({ file: join(outDir, '1-demo.echo.json') })
    expect(JSON.parse(readFileSync(join(outDir, '1-demo.echo.json'), 'utf8'))).toEqual([1])
    expect(JSON.parse(readFileSync(join(outDir, '2-demo.big.json'), 'utf8'))).toEqual(
      bigValue(100_000),
    )
  })
})

describe('repl', () => {
  const stub = (
    timings: number[] = [],
  ): Pick<AgentBridge, 'timed' | 'tools'> & { called: string[] } => {
    const called: string[] = []
    return {
      called,
      tools: () => [
        { name: 'screen.press', description: 'Press' },
        { name: 'screen.text', description: 'Text' },
        { name: 'store.get', description: 'Get' },
      ],
      timed: async (tool: string, ...args: unknown[]) => {
        called.push([tool, ...args.map((a) => JSON.stringify(a))].join(' '))
        if (tool === 'demo.fail') throw new Error('demo.fail: boom')
        return {
          value: args as never,
          ms: timings.shift() ?? 1,
          appMs: 0,
          logs: [],
        }
      },
    }
  }

  async function session(
    bridge: ReturnType<typeof stub>,
    input: string[],
    historyFile?: string,
  ) {
    const output = new PassThrough()
    let text = ''
    output.on('data', (d) => {
      text += String(d)
    })
    await runRepl(bridge, { input: lines(...input), output, historyFile })
    return text
  }

  test('completes dot commands and tool names', () => {
    const names = stub().tools().map((t) => t.name)
    expect(complete('.', names)).toEqual([DOT_COMMANDS, '.'])
    expect(complete('.ti', names)).toEqual([['.time'], '.ti'])
    expect(complete('scr', names)).toEqual([['screen.press', 'screen.text'], 'scr'])
    expect(complete('.tools st', names)).toEqual([['store.get'], 'st'])
    expect(complete('.time screen.p', names)).toEqual([['screen.press'], 'screen.p'])
    expect(complete('screen.press Sa', names)).toEqual([[], 'screen.press Sa'])
  })

  test('runs calls and prints value with timings; errors print plainly off a TTY', async () => {
    const bridge = stub()
    const text = await session(bridge, ['screen.press ["Save"]', 'demo.fail'])
    expect(bridge.called).toEqual(['screen.press "Save"', 'demo.fail'])
    expect(text).toContain('[\n  "Save"\n]')
    expect(text).toContain('1.0 ms round trip, 0 ms in the app')
    expect(text).toContain('boom')
    expect(text).not.toContain('\x1b[')
  })

  test('.tools, .help, .pending, .restore, unknown, .exit', async () => {
    const bridge = stub()
    const text = await session(bridge, [
      '.tools screen',
      '.help',
      '.pending',
      '.restore',
      '.nope',
      '.exit',
      'demo.echo after-exit',
    ])
    expect(text).toContain('screen.press')
    expect(text).not.toContain('store.get')
    expect(text).toContain('Dot commands')
    expect(bridge.called).toEqual(['bridge.pending', 'bridge.restore'])
    expect(text).toContain('Unknown command .nope')
  })

  test('.time runs N times and prints min/median/max', async () => {
    const bridge = stub([5, 1, 3])
    const text = await session(bridge, ['.time demo.echo 1 x3'])
    expect(bridge.called).toHaveLength(3)
    expect(text).toContain('demo.echo x3')
    expect(text).toContain('round trip  min 1.0 / median 3.0 / max 5.0 ms')
  })

  test('history persists, bounded, and loads back', async () => {
    const file = join(dir, 'sub', 'repl_history')
    await session(stub(), ['demo.echo 1', '# skipped', 'demo.echo 2'], file)
    expect(loadHistory(file)).toEqual(['demo.echo 1', 'demo.echo 2'])
    saveHistory(file, Array.from({ length: HISTORY_LIMIT + 20 }, (_, i) => `c ${i}`))
    const kept = loadHistory(file)
    expect(kept).toHaveLength(HISTORY_LIMIT)
    expect(kept.at(-1)).toBe(`c ${HISTORY_LIMIT + 19}`)
    writeFileSync(file, '')
    expect(loadHistory(join(dir, 'missing'))).toEqual([])
  })
})

describe('the CLI', () => {
  const cli = (args: string[], stdin: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (done) => {
        const child = spawn(
          process.execPath,
          [resolve(import.meta.dir, '../../cli.ts'), ...args],
          { env: { ...process.env, AGENT_BRIDGE_STATE_DIR: dir } },
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => (stdout += d))
        child.stderr.on('data', (d) => (stderr += d))
        child.on('close', (code) => done({ code, stdout, stderr }))
        child.stdin.end(stdin)
      },
    )

  test('call --batch prints JSON lines and exits 1 when a call failed', async () => {
    const { metro } = await setup()
    const res = await cli(
      ['call', '--batch', '--metro', metro, '--no-session'],
      'demo.echo 1\ndemo.fail\n',
    )
    const out = res.stdout.trim().split('\n').map((l) => JSON.parse(l))
    expect(out.map((o) => o.ok)).toEqual([true, false])
    expect(res.code).toBe(1)
  })

  test('call --batch exits 0 when every call worked', async () => {
    const { metro } = await setup()
    const res = await cli(
      ['call', '--batch', '--metro', metro, '--no-session'],
      'demo.echo 1\n',
    )
    expect(res.code).toBe(0)
  })

  test('repl with piped stdin behaves like call --batch', async () => {
    const { metro } = await setup()
    const res = await cli(
      ['repl', '--metro', metro, '--no-session'],
      'demo.echo hi\n.help\n',
    )
    const out = res.stdout.trim().split('\n').map((l) => JSON.parse(l))
    expect(out[0]).toMatchObject({ tool: 'demo.echo', ok: true, value: ['hi'] })
    // A dot command is not a tool in batch mode.
    expect(out[1]).toMatchObject({ tool: '.help', ok: false })
  })
})
