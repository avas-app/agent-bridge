import { afterEach, describe, expect, test } from 'bun:test'

import { createGate } from '../gate'
import { restoreTools } from '../tools/restore'
import { resetScenarios, scenarioTools } from '../tools/scenario'
import type { Scenarios, ToolFn, Tools } from '../types'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

/** Scenario and restore tools over `tools`, plus a log of what ran. */
function setup(scenarios: Scenarios, tools: Tools = {}) {
  const all: Tools = {
    ...tools,
    ...scenarioTools(() => scenarios, () => all),
    ...restoreTools(() => all),
  }
  return all
}

afterEach(resetScenarios)

describe('scenarios', () => {
  test('lists scenarios with what they take and whether they are active', async () => {
    const tools = setup({
      signedIn: { description: 'A user', options: { type: 'object' }, apply: () => {} },
      empty: { apply: () => {} },
    })
    await run(tools, 'scenario.apply', 'signedIn')
    expect(run(tools, 'scenario.list')).toEqual([
      { name: 'empty', description: undefined, options: undefined, active: false },
      { name: 'signedIn', description: 'A user', options: { type: 'object' }, active: true },
    ])
  })

  test('apply passes options, calls tools and returns what apply returns', async () => {
    const auth = { token: null as string | null }
    const tools = setup(
      {
        signedIn: {
          apply: async ({ options, call }) => {
            await call('auth.set', 'local-token')
            return { user: (options as { user: string }).user }
          },
        },
      },
      { 'auth.set': (token: string) => (auth.token = token) },
    )
    expect(await run(tools, 'scenario.apply', 'signedIn', { user: 'Ada' })).toEqual({ user: 'Ada' })
    expect(auth.token).toBe('local-token')
  })

  test('unknown scenarios and tools say what exists', async () => {
    const tools = setup({ a: { apply: ({ call }) => call('nope') } })
    await expect(run(tools, 'scenario.apply', 'b') as Promise<unknown>).rejects.toThrow('Unknown scenario "b". Known: a')
    await expect(run(tools, 'scenario.apply', 'a') as Promise<unknown>).rejects.toThrow('Unknown tool "nope"')
  })

  test('bridge.restore runs scenario undos last, newest first', async () => {
    const order: string[] = []
    const tools = setup(
      {
        a: { apply: ({ onUndo }) => onUndo(() => order.push('a')) },
        b: {
          apply: ({ onUndo }) => {
            onUndo(() => order.push('b1'))
            onUndo(async () => {
              await new Promise((r) => setTimeout(r, 2))
              order.push('b2')
            })
          },
        },
      },
      {
        'store.restore': () => order.push('store'),
        'zzz.restore': () => order.push('zzz'),
      },
    )
    await run(tools, 'scenario.apply', 'a')
    await run(tools, 'scenario.apply', 'b')
    const result = await run(tools, 'bridge.restore')
    expect(order).toEqual(['store', 'zzz', 'b2', 'b1', 'a'])
    expect(Object.keys(result as object)).toEqual(['store.restore', 'zzz.restore', 'scenario.restore'])
    expect((result as Record<string, unknown>)['scenario.restore']).toEqual(['b', 'a'])
    // Nothing left to undo.
    expect(await run(tools, 'scenario.restore')).toEqual([])
  })

  test('applying an active scenario undoes it first', async () => {
    const order: string[] = []
    const tools = setup({
      s: {
        apply: ({ options, onUndo }) => {
          order.push(`apply ${options}`)
          onUndo(() => order.push(`undo ${options}`))
        },
      },
    })
    await run(tools, 'scenario.apply', 's', 1)
    await run(tools, 'scenario.apply', 's', 2)
    expect(order).toEqual(['apply 1', 'undo 1', 'apply 2'])
  })

  test('a failed apply undoes what it had registered and reports why', async () => {
    const order: string[] = []
    const tools = setup({
      s: {
        apply: ({ onUndo }) => {
          onUndo(() => order.push('undone'))
          throw new Error('no fixtures')
        },
      },
    })
    await expect(run(tools, 'scenario.apply', 's') as Promise<unknown>).rejects.toThrow('Scenario "s" failed: no fixtures')
    expect(order).toEqual(['undone'])
    expect(run(tools, 'scenario.list')).toMatchObject([{ active: false }])
  })

  test('a failing undo still runs the rest and fails the restore', async () => {
    const order: string[] = []
    const tools = setup({
      s: {
        apply: ({ onUndo }) => {
          onUndo(() => order.push('first'))
          onUndo(() => {
            throw new Error('native rule stuck')
          })
        },
      },
    })
    await run(tools, 'scenario.apply', 's')
    const result = (await run(tools, 'bridge.restore')) as Record<string, unknown>
    expect(order).toEqual(['first'])
    expect(result['scenario.restore']).toEqual({ error: 's: native rule stuck' })
  })
})

describe('scenario options', () => {
  const schema = {
    type: 'object',
    properties: {
      user: {
        type: 'object',
        properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } },
      },
      plan: { enum: ['free', 'pro'] },
      tags: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
    },
  } as const

  const failure = async (tools: Tools, options: unknown) => {
    const error = await (run(tools, 'scenario.apply', 's', options) as Promise<unknown>).then(
      () => null,
      (e: Error) => e.message,
    )
    if (error === null) throw new Error('expected apply to fail')
    return error
  }

  test('good options reach apply as they are', async () => {
    const tools = setup({ s: { options: schema, apply: ({ options }) => options } })
    const options = { user: { name: 'Ada', age: 36 }, plan: 'pro', tags: [{ id: 'a' }] }
    expect(await run(tools, 'scenario.apply', 's', options)).toEqual(options)
    // No options: checked as {}, but apply still gets undefined.
    expect(await run(tools, 'scenario.apply', 's')).toBeUndefined()
  })

  test('bad options name each problem, and nothing is applied', async () => {
    let applied = 0
    const tools = setup({ s: { options: schema, apply: () => void (applied += 1) } })
    const message = await failure(tools, {
      user: { name: 3, age: -1, nmae: 'x' },
      plan: 'gold',
      usr: {},
      tags: [{ id: 'a', ID: 'b' }],
    })
    expect(applied).toBe(0)
    expect(message).toStartWith('Scenario "s" got bad options, nothing was applied:')
    for (const line of [
      'options: unknown option "usr". Known: user, plan, tags',
      'options/user: unknown option "nmae". Known: name, age',
      'options/tags/0: unknown option "ID". Known: id',
      'options/user/name: Instance type "number" is invalid. Expected "string".',
      'options/user/age:',
      'options/plan:',
    ])
      expect(message).toContain(`- ${line}`)
    // Cascades ("does not match schema") stay out.
    expect(message).not.toContain('does not match schema')
  })

  test('required options are checked when none are passed', async () => {
    const tools = setup({
      s: { options: { type: 'object', properties: { user: {} }, required: ['user'] }, apply: () => {} },
    })
    expect(await failure(tools, undefined)).toContain('options: Instance does not have required property "user".')
  })

  test('additionalProperties or patternProperties keeps an object open', async () => {
    const tools = setup({
      s: {
        options: {
          type: 'object',
          properties: { a: { type: 'object', properties: {}, patternProperties: { '^x': {} } } },
          additionalProperties: true,
        },
        apply: () => 'ok',
      },
    })
    expect(await run(tools, 'scenario.apply', 's', { a: { x1: 1 }, other: 1 })).toBe('ok')
  })

  test("the app's own additionalProperties: false reads as an unknown option", async () => {
    const tools = setup({
      s: { options: { type: 'object', properties: { a: {} }, additionalProperties: false }, apply: () => {} },
    })
    const message = await failure(tools, { b: 1 })
    expect(message).toContain('- options: unknown option "b". Known: a')
    expect(message).not.toContain('False boolean schema')
  })

  test('a bad re-apply leaves the active scenario alone', async () => {
    const order: string[] = []
    const tools = setup({
      s: { options: schema, apply: ({ onUndo }) => onUndo(() => order.push('undo')) },
    })
    await run(tools, 'scenario.apply', 's', { plan: 'pro' })
    await failure(tools, { plan: 'gold' })
    expect(order).toEqual([])
    expect(run(tools, 'scenario.list')).toMatchObject([{ active: true }])
  })
})

describe('createGate', () => {
  test('counts closes and tells subscribers when it closes and opens', () => {
    const gate = createGate('realtime')
    const seen: boolean[] = []
    const off = gate.subscribe((closed) => seen.push(closed))
    expect(gate.closed).toBe(false)
    const a = gate.close()
    const b = gate.close()
    expect(gate.closed).toBe(true)
    a()
    a()
    expect(gate.closed).toBe(true)
    b()
    expect(gate.closed).toBe(false)
    expect(seen).toEqual([true, false])
    off()
    gate.close()
    expect(seen).toEqual([true, false])
  })
})
