import { afterEach, describe, expect, test } from 'bun:test'

import { cdpTransport } from '../../runtime/cdp-transport'
import { createRegistry } from '../../runtime/registry'
import { restoreTools } from '../../runtime/tools/restore'
import { resetScenarios, scenarioTools } from '../../runtime/tools/scenario'
import type { Scenarios, Tools } from '../../runtime/types'
import { PROTOCOL_VERSION } from '../../shared/protocol'
import {
  type FlowModule,
  flowScenarios,
  mergeScenarios,
  parseScenarioFlag,
  runFlow,
  runFlows,
  deepMatches,
} from '../flow'
import { renderJson, renderJunit } from '../flow-report'
import {
  type AgentBridge,
  AgentBridgeCallError,
  connect,
  runFlow as exported,
} from '../index'
import { startFakeMetro } from './fake-metro'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  resetScenarios()
})

/** An app over CDP on a fake Metro, with scenarios, and a client connected to it. */
async function app(scenarios: Scenarios | null, extra: Tools = {}) {
  const all: Tools = {
    ...extra,
    ...(scenarios && scenarioTools(() => scenarios, () => all)),
    ...restoreTools(() => all),
  }
  const registry = createRegistry(() => all)
  const stop = cdpTransport().start({
    info: () => ({
      deviceId: 'd1',
      name: 'flow-app',
      platform: 'ios',
      protocol: PROTOCOL_VERSION,
      tools: registry.list(),
    }),
    dispatch: (call) => registry.dispatch(call, 'd1'),
  })
  const metro = await startFakeMetro()
  const bridge = await connect({ metro: metro.metro, transport: 'cdp' })
  cleanups.push(stop, () => metro.close(), () => bridge.close())
  return bridge
}

const quiet = () => {
  const lines: string[] = []
  return { lines, print: (line: string) => void lines.push(line) }
}

describe('flowScenarios', () => {
  test('reads scenario and scenarios, names or { name, options }', () => {
    expect(flowScenarios({})).toEqual([])
    expect(
      flowScenarios({
        scenario: 'signedIn',
        scenarios: [{ name: 'cart', options: { items: 2 } }],
      }),
    ).toEqual([{ name: 'signedIn' }, { name: 'cart', options: { items: 2 } }])
    expect(() => flowScenarios({ scenarios: [3 as never] })).toThrow('is a name or { name, options }')
  })
})

describe('--scenario', () => {
  test('parses a name, or a name with JSON options', () => {
    expect(parseScenarioFlag('signedIn')).toEqual({ name: 'signedIn' })
    expect(parseScenarioFlag('signedIn={"user":{"name":"A=B"}}')).toEqual({
      name: 'signedIn',
      options: { user: { name: 'A=B' } },
    })
    expect(() => parseScenarioFlag('signedIn={nope')).toThrow('must be JSON')
  })

  test('adds to the flow\'s scenarios, replacing one of the same name', () => {
    expect(
      mergeScenarios(
        [{ name: 'signedIn', options: 1 }, { name: 'cart' }],
        [{ name: 'signedIn', options: 2 }, { name: 'dark' }],
      ),
    ).toEqual([{ name: 'cart' }, { name: 'signedIn', options: 2 }, { name: 'dark' }])
  })
})

describe('runFlow', () => {
  test('is exported from the client entry', () => {
    expect(exported).toBe(runFlow)
  })

  test('surfaces the reload notice a session attaches, on success and on failure', async () => {
    const real = await app(null, { 'demo.echo': (n: number) => n })
    const notice = 'app reloaded; 1 pending restore lost: store'
    let failNext = false
    const bridge: AgentBridge = {
      ...real,
      timed: (async (tool: string, ...args: unknown[]) => {
        if (failNext) throw new AgentBridgeCallError(tool, 'gone', [], notice)
        return { ...(await real.timed(tool, ...args)), notice }
      }) as AgentBridge['timed'],
    }
    const out = quiet()
    const result = await runFlow(
      bridge,
      {
        default: async ({ step, call }) => {
          await step('echo', 'demo.echo', 1)
          failNext = true
          await call('demo.echo', 2).catch(() => {})
        },
      },
      out,
    )
    // The closing restore carries the mock's notice too.
    expect(result.notices).toEqual([notice, notice, notice])
    expect(out.lines.filter((l) => l === `   ! ${notice}`)).toHaveLength(3)
    expect(out.lines.at(-1)).toContain('the app reloaded')
  })

  test('applies extra scenarios to a flow that declares none', async () => {
    const order: string[] = []
    const bridge = await app({
      signedIn: {
        apply: ({ options, onUndo }) => {
          order.push(`apply ${JSON.stringify(options)}`)
          onUndo(() => order.push('undo'))
        },
      },
    })
    await runFlow(
      bridge,
      { default: async () => void order.push('flow') },
      { ...quiet(), scenarios: [parseScenarioFlag('signedIn={"user":"Ada"}')] },
    )
    expect(order).toEqual(['apply {"user":"Ada"}', 'flow', 'undo'])
  })

  test('applies declared scenarios, hands the flow their results, then restores', async () => {
    const order: string[] = []
    const bridge = await app(
      {
        signedIn: {
          apply: ({ options, onUndo }) => {
            order.push('apply')
            onUndo(() => order.push('undo'))
            return { user: (options as { user: string }).user }
          },
        },
      },
      { 'app.restore': () => order.push('app.restore') },
    )
    let seen: unknown
    const out = quiet()
    const result = await runFlow(
      bridge,
      {
        scenarios: [{ name: 'signedIn', options: { user: 'Ada' } }],
        default: async ({ scenarios, call }) => {
          order.push('flow')
          seen = scenarios
          expect(await call('scenario.list')).toMatchObject([{ name: 'signedIn', active: true }])
        },
      },
      out,
    )
    expect(seen).toEqual({ signedIn: { user: 'Ada' } })
    expect(order).toEqual(['apply', 'flow', 'app.restore', 'undo'])
    expect(result).toMatchObject({ steps: 2, restoreErrors: [] })
    expect(out.lines[0]).toContain('scenario signedIn')
    expect(out.lines[1]).toContain('restore')
  })

  test('restores when the flow fails, and rethrows', async () => {
    const order: string[] = []
    const bridge = await app({
      signedIn: { apply: ({ onUndo }) => onUndo(() => order.push('undo')) },
    })
    const flow: FlowModule = {
      scenario: 'signedIn',
      default: async () => {
        throw new Error('flow broke')
      },
    }
    await expect(runFlow(bridge, flow, quiet())).rejects.toThrow('flow broke')
    expect(order).toEqual(['undo'])
  })

  test('reports a failing restorer', async () => {
    const bridge = await app({
      s: {
        apply: ({ onUndo }) =>
          onUndo(() => {
            throw new Error('stuck')
          }),
      },
    })
    const out = quiet()
    const result = await runFlow(bridge, { scenario: 's', default: async () => {} }, out)
    expect(result.restoreErrors).toEqual(['scenario.restore: s: stuck'])
    expect(out.lines.some((l) => l.includes('restore failed: scenario.restore: s: stuck'))).toBe(true)
  })

  test('says so when the app defines no scenarios', async () => {
    const bridge = await app(null)
    await expect(
      runFlow(bridge, { scenario: 'signedIn', default: async () => {} }, quiet()),
    ).rejects.toThrow('the app defines none')
  })

  test('a flow without scenarios still restores, unless keep is set', async () => {
    const calls: string[] = []
    const bridge = {
      transport: 'cdp',
      tools: () => [{ name: 'bridge.restore' }],
      timed: async (tool: string) => {
        calls.push(tool)
        return { value: {}, ms: 1, appMs: 1, logs: [] }
      },
    } as unknown as AgentBridge
    const flow = { default: async ({ step }: { step: (l: string, t: string) => Promise<unknown> }) => void (await step('one', 'x.y')) }
    await runFlow(bridge, flow as FlowModule, quiet())
    expect(calls).toEqual(['x.y', 'bridge.restore'])
    calls.length = 0
    await runFlow(bridge, flow as FlowModule, { ...quiet(), keep: true })
    expect(calls).toEqual(['x.y'])
  })

  test('step takes its arguments spread, or one array as the whole list, like the CLI', async () => {
    const seen: unknown[][] = []
    const bridge = await app(null, { 'x.echo': (...args: unknown[]) => (seen.push(args), args) })
    const out = quiet()
    await runFlow(
      bridge,
      {
        default: async ({ step }) => {
          await step('spread', 'x.echo', 'Confirm', 1)
          await step('array', 'x.echo', ['Confirm', 1])
          await step('nested', 'x.echo', [['Confirm']])
        },
      },
      out,
    )
    expect(seen).toEqual([['Confirm', 1], ['Confirm', 1], [['Confirm']]])
  })
})

describe('expect', () => {
  const screen = (texts: string[]) => ({
    'screen.waitFor': (target: string, o?: { gone?: boolean }) => {
      const has = texts.includes(target)
      if (o?.gone ? has : !has) throw new Error(`timed out waiting for ${target}`)
      return { ms: 1 }
    },
    'router.current': () => ({ pathname: '/home' }),
    'demo.state': () => ({ user: { name: 'Ada', id: 1 }, tags: ['a'] }),
  })

  test('passes and fails with readable messages', async () => {
    const bridge = await app(null, screen(['Hello']))
    const run = (fn: (e: import('../flow').FlowExpect) => Promise<void>) =>
      runFlow(bridge, { default: async ({ expect: e }) => fn(e) }, quiet())
    await run(async (e) => {
      await e.text('Hello')
      await e.gone('Bye')
      await e.route('/home')
      await e.result('demo.state', [], { user: { name: 'Ada' } })
    })
    await expect(run((e) => e.text('Bye'))).rejects.toThrow('expected "Bye" on screen: ')
    await expect(run((e) => e.gone('Hello'))).rejects.toThrow('expected "Hello" to be off screen')
    await expect(run((e) => e.route('/plants', { timeoutMs: 60 }))).rejects.toThrow(
      'expected route /plants, got /home',
    )
    await expect(run((e) => e.result('demo.state', [], { user: { name: 'Bob' } }))).rejects.toThrow(
      'expected demo.state to match',
    )
  })

  test('deepMatches: objects by given keys, arrays exactly', () => {
    expect(deepMatches({ a: 1, b: 2 }, { a: 1 })).toBe(true)
    expect(deepMatches([1, 2], [1])).toBe(false)
    expect(deepMatches({ a: [{ x: 1, y: 2 }] }, { a: [{ x: 1 }] })).toBe(true)
    expect(deepMatches(null, {})).toBe(false)
  })

  test('deepMatches: a RegExp matches strings; other class instances are rejected', () => {
    expect(deepMatches({ title: 'Fern is thirsty' }, { title: /thirsty$/ })).toBe(true)
    expect(deepMatches({ title: 'ok' }, { title: /thirsty/ })).toBe(false)
    expect(deepMatches({ title: 3 }, { title: /3/ })).toBe(false)
    expect(() => deepMatches({ at: 1 }, { at: new Date(1) })).toThrow('Date')
    expect(() => deepMatches({}, new Map())).toThrow('Map')
  })

  test('expect.route polls quietly: one step line, one step', async () => {
    let polls = 0
    const bridge = await app(null, {
      'router.current': () => ({ pathname: ++polls < 4 ? '/a' : '/b' }),
    })
    const out = quiet()
    const result = await runFlow(
      bridge,
      { default: async ({ expect: e }) => e.route('/b') },
      out,
    )
    expect(polls).toBeGreaterThanOrEqual(4)
    // The route step and the closing restore.
    expect(result.steps).toBe(2)
    expect(out.lines.filter((l) => l.includes('expect route'))).toHaveLength(1)
  })
})

describe('runFlows', () => {
  const mk = (name: string, fn: FlowModule['default']) => ({ file: `${name}.flow.mjs`, name, module: { default: fn } })

  test('runs in order, restores after each, shows the screen on failure, and bail skips the rest', async () => {
    const undone: string[] = []
    const bridge = await app(null, {
      'app.set': (v: string) => undone.push(`set ${v}`),
      'screen.snapshot': () => ({ elements: [{ kind: 'text', text: 'Oops' }, { kind: 'button', testID: 'ok', label: 'OK' }] }),
      'router.current': () => ({ pathname: '/x' }),
    })
    const out = quiet()
    const entries = [
      mk('a', async ({ step }) => void (await step('s', 'app.set', 'a'))),
      mk('b', async () => {
        throw new Error('boom')
      }),
      mk('c', async () => {}),
    ]
    const runs = await runFlows(bridge, entries, { ...out, bail: true })
    expect(runs.map((r) => r.status)).toEqual(['passed', 'failed', 'skipped'])
    expect(runs[1]!.error).toBe('boom')
    expect(runs[1]!.state).toEqual({ screen: ['text "Oops"', 'button #ok "OK"'], route: { pathname: '/x' } })
    expect(out.lines.filter((l) => l.includes('restore'))).toHaveLength(2)
    expect(out.lines).toContain('   FAILED: boom')
    const all = await runFlows(bridge, entries, quiet())
    expect(all.map((r) => r.status)).toEqual(['passed', 'failed', 'passed'])
  })

  test('reporters', () => {
    const runs = [
      { file: 'a.flow.mjs', name: 'a', status: 'passed', ms: 10, steps: 1, errors: 0, restoreErrors: [], notices: [] },
      { file: 'b.flow.mjs', name: 'b<>', status: 'failed', ms: 20, steps: 1, errors: 0, error: 'bad "x"', state: { screen: ['text "Hi"'] }, restoreErrors: [], notices: [] },
    ] as import('../flow').FlowRun[]
    expect(JSON.parse(renderJson(runs))).toMatchObject({ passed: 1, failed: 1, skipped: 0 })
    const xml = renderJunit(runs)
    expect(xml).toContain('tests="2" failures="1"')
    expect(xml).toContain('name="b&#60;&#62;"')
    expect(xml).toContain('<failure message="bad &#34;x&#34;">')
    expect(xml).toContain('text &#34;Hi&#34;')
  })

  test('junit: strips ANSI sequences and U+FFFE, uses the folder as classname, relative files', () => {
    const run = (file: string, error?: string) =>
      ({ file, name: 'same', status: error ? 'failed' : 'passed', ms: 1, steps: 0, errors: 0, error, restoreErrors: [], notices: [] }) as import('../flow').FlowRun
    const xml = renderJunit([
      run('flows/a/same.flow.mjs', '\u001b[31mred\u001b[0m\u001b[1;32m!\uFFFE\uFFFF'),
      run('flows/b/same.flow.mjs'),
      run('top.flow.mjs'),
    ])
    expect(xml).toContain('message="red!"')
    expect(xml).not.toContain('\u001b')
    expect(xml).toContain('classname="flows/a" name="same" file="flows/a/same.flow.mjs"')
    expect(xml).toContain('classname="flows/b" name="same"')
    expect(xml).toContain('classname="agent-bridge" name="same" file="top.flow.mjs"')
  })
})

describe('failures and lost apps', () => {
  const mk = (name: string, fn: FlowModule['default']) => ({ file: `${name}.flow.mjs`, name, module: { default: fn } })
  /** A bridge whose calls go through `hook` first, to fake a lost app, extra logs or a notice. */
  const wrap = (real: AgentBridge, hook: (tool: string) => Partial<{ logs: AgentBridge extends never ? never : never }> | unknown) =>
    ({
      ...real,
      call: (async (tool: string, ...a: unknown[]) => {
        hook(tool)
        return real.call(tool, ...a)
      }) as AgentBridge['call'],
      timed: (async (tool: string, ...a: unknown[]) => {
        const extra = hook(tool) as { logs?: never[]; notice?: string } | undefined
        const r = await real.timed(tool, ...a)
        return { ...r, ...extra }
      }) as AgentBridge['timed'],
    }) as AgentBridge

  test('the reload notice is reported when the failure snapshot is the first call after the reload', async () => {
    const real = await app(null, {
      'screen.snapshot': () => ({ elements: [] }),
      'demo.echo': (n: number) => n,
    })
    const notice = 'app reloaded; 1 pending restore lost: store'
    let sawEcho = false
    const bridge = wrap(real, (tool) => {
      if (tool === 'demo.echo') sawEcho = true
      return tool === 'screen.snapshot' && sawEcho ? { notice } : undefined
    })
    const runs = await runFlows(
      bridge,
      [mk('a', async ({ step }) => { await step('echo', 'demo.echo', 1); throw new Error('x') })],
      quiet(),
    )
    expect(runs[0]!.notices).toEqual([notice])
  })

  test('a lost app: error first, no snapshot or restore waits, later flows skipped with a reason', async () => {
    const calls: string[] = []
    const real = await app(null, {
      'screen.snapshot': () => ({ elements: [] }),
      'router.current': () => ({ pathname: '/' }),
      'demo.echo': (n: number) => n,
    })
    let lost = false
    const bridge = wrap(real, (tool) => {
      calls.push(tool)
      if (lost) throw new Error(`No reply to "${tool}" within 10000 ms`)
    })
    const out = quiet()
    const runs = await runFlows(
      bridge,
      [
        mk('a', async ({ step }) => {
          lost = true
          await step('echo', 'demo.echo', 1)
        }),
        mk('b', async () => {}),
      ],
      out,
    )
    expect(calls).toEqual(['demo.echo'])
    expect(runs.map((r) => r.status)).toEqual(['failed', 'skipped'])
    expect(runs[1]!.error).toContain('stopped answering')
    expect(out.lines.some((l) => l.includes('FAILED: No reply'))).toBe(true)
  })

  test('--keep with a lost app still skips the rest; a failing restore tool does not', async () => {
    const real = await app(null, { 'demo.echo': (n: number) => n })
    let lost = false
    const bridge = wrap(real, () => {
      if (lost) throw new Error('socket closed')
    })
    const kept = await runFlows(
      bridge,
      [mk('a', async ({ step }) => { lost = true; await step('e', 'demo.echo', 1) }), mk('b', async () => {})],
      { ...quiet(), keep: true },
    )
    expect(kept.map((r) => r.status)).toEqual(['failed', 'skipped'])

    const failing = {
      ...real,
      timed: (async (tool: string, ...a: unknown[]) => {
        if (tool === 'bridge.restore') throw new AgentBridgeCallError(tool, 'restorer broke')
        return real.timed(tool, ...a)
      }) as AgentBridge['timed'],
    } as AgentBridge
    const runs = await runFlows(failing, [mk('a', async () => {}), mk('b', async () => {})], quiet())
    expect(runs.map((r) => r.status)).toEqual(['failed', 'failed'])
  })

  test('one flow in text mode: no header, the failure goes to printError; restore errors do not trip --strict', async () => {
    const real = await app(null, {})
    const bridge = wrap(real, (tool) =>
      tool === 'bridge.restore'
        ? { logs: [{ level: 'error', message: 'noisy restore', ts: 0 }] }
        : undefined,
    )
    const out = quiet()
    const err: string[] = []
    const runs = await runFlows(
      bridge,
      [mk('only', async () => { throw new Error('nope') })],
      { ...out, single: true, strict: true, printError: (l) => void err.push(l) },
    )
    expect(out.lines.some((l) => l === '' || l === '\nonly' || l.startsWith('\n'))).toBe(false)
    expect(out.lines.some((l) => l.includes('FAILED'))).toBe(false)
    expect(err).toEqual(['   FAILED: nope'])
    const ok = await runFlows(bridge, [mk('only', async () => {})], { ...out, single: true, strict: true })
    expect(ok[0]!.status).toBe('passed')
    expect(runs[0]!.status).toBe('failed')
  })
})
