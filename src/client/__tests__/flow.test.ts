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
} from '../flow'
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
    expect(result.notices).toEqual([notice, notice])
    expect(out.lines.filter((l) => l === `   ! ${notice}`)).toHaveLength(2)
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

  test('a flow without scenarios runs as before, with no restore', async () => {
    const calls: string[] = []
    const bridge = {
      transport: 'cdp',
      tools: () => [],
      timed: async (tool: string) => {
        calls.push(tool)
        return { value: 1, ms: 1, appMs: 1, logs: [] }
      },
    } as unknown as AgentBridge
    await runFlow(bridge, { default: async ({ step }) => void (await step('one', 'x.y')) }, quiet())
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
