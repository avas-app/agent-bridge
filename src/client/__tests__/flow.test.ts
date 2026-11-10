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
})
