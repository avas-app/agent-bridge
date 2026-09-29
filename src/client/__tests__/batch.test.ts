import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { mkdirSync } from 'node:fs'

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
import { parseBatchLine, parseCallArgs, parseCallArgv, runBatch } from '../batch'
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
  bridge: Pick<AgentBridge, 'timed' | 'tools'>,
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
        if (tool === 'demo.slow') await new Promise((r) => setTimeout(r, 3))
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
    // Dot commands are handled here, not sent to the app.
    expect(out[1]).toMatchObject({ tool: '.help', ok: false })
    expect(out[1]?.error).toContain('Unknown command')
  })
})

describe('review fixes', () => {
  const stubBridge = (hang = false) => {
    const called: string[] = []
    return {
      called,
      tools: () => [{ name: 'demo.echo', description: 'Echo' }],
      timed: (async (tool: string, ...args: unknown[]) => {
        called.push(tool)
        if (hang && tool === 'demo.hang') await new Promise(() => {})
        if (tool === 'demo.slow') await new Promise((r) => setTimeout(r, 3))
        if (tool === 'demo.fail') throw new Error('boom')
        return { value: args, ms: 1, appMs: 0, logs: [] }
      }) as AgentBridge['timed'],
    }
  }
  const collect = async (bridge: ReturnType<typeof stubBridge>, input: string[], options = {}) => {
    const out: Array<Record<string, any>> = []
    await runBatch(bridge, lines(...input), {
      ...options,
      write: (l) => out.push(JSON.parse(l)),
    })
    return out
  }
  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

  test('args that look like JSON but do not parse are errors, not strings', async () => {
    const bridge = stubBridge()
    const out = await collect(bridge, [
      'demo.echo [1,2',
      'demo.echo {bad json',
      'demo.echo "a" "b"',
      'demo.echo plain words',
      'demo.echo "quoted"',
    ])
    expect(out.map((o) => o.ok)).toEqual([false, false, false, true, true])
    expect(out[0]?.error).toContain("don't parse")
    expect(bridge.called).toEqual(['demo.echo', 'demo.echo'])
  })

  test('dot lines in batch run locally: .tools, .time, .exit', async () => {
    const bridge = stubBridge()
    const out = await collect(bridge, [
      '.tools demo',
      '.time demo.echo 1 x3',
      '.nope',
      '.exit',
      'demo.echo never',
    ])
    expect(out[0]?.value).toEqual([{ name: 'demo.echo', description: 'Echo' }])
    expect(out[1]?.value).toMatchObject({ call: 'demo.echo', runs: 3 })
    expect(out[2]?.ok).toBe(false)
    expect(out).toHaveLength(3)
    expect(bridge.called).toEqual(['demo.echo', 'demo.echo', 'demo.echo'])
  })

  test('--stop-on-error returns while stdin stays open', async () => {
    const input = new PassThrough()
    input.write('demo.fail\n')
    const result = await Promise.race([
      runBatch(stubBridge(), input, { stopOnError: true, write: () => {} }),
      tick(2000).then(() => 'hung'),
    ])
    expect(result).toEqual({ calls: 1, failed: 1 })
    expect(input.destroyed).toBe(true)
  })

  test('--out refuses a file or a non-empty directory; the hint names a directory', async () => {
    const file = join(dir, 'a-file')
    writeFileSync(file, 'x')
    await expect(runBatch(stubBridge(), lines('demo.echo'), { outDir: file })).rejects.toThrow('is a file')
    const full = join(dir, 'full')
    mkdirSync(full)
    writeFileSync(join(full, 'old.json'), '{}')
    await expect(runBatch(stubBridge(), lines('demo.echo'), { outDir: full })).rejects.toThrow('is not empty')
    const bridge = stubBridge()
    bridge.timed = (async () => ({ value: 'x'.repeat(40_000), ms: 1, appMs: 0, logs: [] })) as AgentBridge['timed']
    const [big] = await collect(bridge, ['demo.big'])
    expect(big?.value.hint).toContain('--out <dir>')
  })

  test('repl: Ctrl-C clears the line when idle and gives up on a running call', async () => {
    const bridge = stubBridge(true)
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', (d) => {
      text += String(d)
    })
    let rl!: import('node:readline').Interface
    const done = runRepl(bridge, { input, output, onReady: (r) => (rl = r) })
    rl.emit('SIGINT')
    await tick()
    expect(text).toContain('^C')
    input.write('demo.hang\n')
    await tick()
    rl.emit('SIGINT')
    await tick()
    expect(text).toContain('Interrupted. The call may still finish in the app.')
    input.write('demo.echo 1\n')
    await tick()
    expect(text).toContain('1.0 ms round trip')
    input.end()
    await done
  })

  test('repl: Ctrl-C stops .time between runs; N is capped', async () => {
    const bridge = stubBridge()
    let rl!: import('node:readline').Interface
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', (d) => {
      text += String(d)
    })
    const done = runRepl(bridge, { input, output, onReady: (r) => (rl = r) })
    input.write('.time demo.slow x5000\n')
    await tick(40)
    rl.emit('SIGINT')
    await tick()
    expect(text).toContain('capped at 1000')
    expect(text).toContain('Interrupted')
    const seen = bridge.called.length
    expect(seen).toBeLessThan(1000)
    await tick()
    expect(bridge.called.length).toBe(seen)
    input.end()
    await done
  })

  test('repl: history is appended as lines are entered', async () => {
    const file = join(dir, 'h', 'repl_history')
    const input = new PassThrough()
    const output = new PassThrough()
    const done = runRepl(stubBridge(), { input, output, historyFile: file })
    input.write('demo.echo 1\n')
    await tick()
    expect(loadHistory(file)).toEqual(['demo.echo 1']) // saved before the REPL ends
    input.end()
    await done
  })

  const cli = (args: string[]) =>
    spawn(process.execPath, [resolve(import.meta.dir, '../../cli.ts'), ...args], {
      env: { ...process.env, AGENT_BRIDGE_STATE_DIR: dir },
    })

  test('CLI: --stop-on-error exits with stdin still open; EPIPE on stdout is quiet', async () => {
    const { metro } = await setup()
    const a = cli(['call', '--batch', '--stop-on-error', '--metro', metro, '--no-session'])
    a.stdin.write('demo.fail\n')
    const t0 = performance.now()
    await new Promise((r) => a.on('close', r))
    expect(performance.now() - t0).toBeLessThan(4000)

    const b = cli(['call', '--batch', '--metro', metro, '--no-session'])
    let stderr = ''
    b.stderr.on('data', (d) => (stderr += d))
    b.stdout.destroy()
    b.stdin.write('demo.echo 1\n'.repeat(20))
    b.stdin.end()
    const code = await new Promise((r) => b.on('close', r))
    expect(stderr).not.toContain('EPIPE')
    expect(code).toBe(0)
  })

  test('CLI: a real crash prints the error and exits 1, not 7', async () => {
    const flow = join(dir, 'crash.mjs')
    writeFileSync(flow, "setTimeout(() => { throw new Error('flow crashed') }, 0)\nexport default async () => {}\n")
    const child = cli(['run', flow, '--metro', 'localhost:1', '--no-session'])
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    const code = await new Promise((r) => child.on('close', r))
    expect(stderr).toContain('flow crashed')
    expect(code).toBe(1)
  })

  const run = async (args: string[], stdin?: string, cwd?: string) => {
    const child = spawn(process.execPath, [resolve(import.meta.dir, '../../cli.ts'), ...args], {
      env: { ...process.env, AGENT_BRIDGE_STATE_DIR: dir },
      cwd,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.stdin.end(stdin)
    const code = await new Promise((r) => child.on('close', r))
    return { stdout, stderr, code }
  }

  test('CLI: call reads its arguments from a file or stdin, past the argv limit', async () => {
    const { metro } = await setup()
    const flags = ['--metro', metro, '--no-session']
    const big = 'x'.repeat(1_500_000)
    const file = join(dir, 'big.json')
    writeFileSync(file, JSON.stringify(['/feed', { big }]))
    const out = join(dir, 'out.json')
    const fromFile = await run(['call', 'demo.echo', `@${file}`, '--out', out, ...flags])
    expect(fromFile.code).toBe(0)
    const echoed = JSON.parse(readFileSync(out, 'utf8'))
    expect(echoed[0]).toBe('/feed')
    expect(echoed[1].big.length).toBe(big.length)

    // A single value is one argument; @- is stdin.
    const fromStdin = await run(['call', 'demo.echo', '@-', ...flags], '{"a":1}')
    expect(JSON.parse(fromStdin.stdout)).toEqual([{ a: 1 }])

    // Several words: each is one argument, @file is that file's JSON as-is.
    writeFileSync(join(dir, 'list.json'), '[1,2]')
    const mixed = await run(['call', 'demo.echo', '"/feed"', 'text', '@list.json', ...flags], undefined, dir)
    expect(JSON.parse(mixed.stdout)).toEqual(['/feed', 'text', [1, 2]])
  })

  test('CLI: a bad @file names the path', async () => {
    const flags = ['--metro', 'localhost:1', '--no-session']
    const missing = await run(['call', 'demo.echo', '@nope.json', ...flags])
    expect(missing.stderr).toContain('Cannot read arguments file nope.json')
    expect(missing.code).toBe(1)
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{oops')
    const invalid = await run(['call', 'demo.echo', `@${bad}`, ...flags])
    expect(invalid.stderr).toContain(`${bad} is not valid JSON`)
    expect(invalid.code).toBe(1)
  })

  test('parseCallArgv: @file rules', () => {
    const read = (path: string) => (path === 'list' ? '[1,2]' : path === 'one' ? '{"a":1}' : '{bad')
    expect(parseCallArgv(['@list'], read)).toEqual([1, 2])
    expect(parseCallArgv(['@one'], read)).toEqual([{ a: 1 }])
    expect(parseCallArgv(['"/feed"', '@list'], read)).toEqual(['/feed', [1, 2]])
    expect(parseCallArgv(['"@user"'], read)).toEqual(['@user'])
    expect(parseCallArgv(['a', '7'], read)).toEqual(['a', 7])
    expect(() => parseCallArgv(['@bad'], read)).toThrow('bad is not valid JSON')
    expect(() => parseCallArgv(['@'], read)).toThrow('needs a path')
  })

  test('call --batch: a line can take its arguments from a file', async () => {
    const { metro } = await setup()
    const bridge = await connect({ metro, transport: 'expo' })
    cleanups.push(() => bridge.close())
    writeFileSync(join(dir, 'args.json'), '["a",{"b":2}]')
    const { out, failed } = await batch(bridge, [
      `demo.echo @${join(dir, 'args.json')}`,
      'demo.echo @missing.json',
      'demo.echo @-',
    ])
    expect(out[0]).toMatchObject({ ok: true, value: ['a', { b: 2 }] })
    expect(out[1]?.error).toContain('Cannot read arguments file missing.json')
    expect(out[2]?.error).toContain('stdin carries the calls')
    expect(failed).toBe(2)
  })
})
