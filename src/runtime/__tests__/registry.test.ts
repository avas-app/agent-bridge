import { describe, expect, test } from 'bun:test'

import { createRegistry } from '../registry'
import { toJson } from '../to-json'

const registry = createRegistry(() => ({
  'demo.echo': (...args: unknown[]) => args,
  'demo.async': { description: 'Resolves later', run: async (n: number) => n * 2 },
  'demo.throws': () => {
    throw new Error('nope')
  },
}))

describe('registry', () => {
  test('lists tools with descriptions, sorted', () => {
    expect(registry.list()).toEqual([
      { name: 'demo.async', description: 'Resolves later' },
      { name: 'demo.echo', description: undefined },
      { name: 'demo.throws', description: undefined },
    ])
  })

  test('runs sync and async tools', async () => {
    expect(await registry.dispatch({ id: '1', tool: 'demo.echo', args: [1, 'a'] }, 'dev')).toMatchObject({
      id: '1',
      from: 'dev',
      ok: true,
      value: [1, 'a'],
    })
    expect(await registry.dispatch({ id: '2', tool: 'demo.async', args: [21] }, 'dev')).toMatchObject({
      ok: true,
      value: 42,
    })
  })

  test('reports thrown errors and unknown tools as results', async () => {
    expect(await registry.dispatch({ id: '3', tool: 'demo.throws' }, 'dev')).toMatchObject({ ok: false, error: 'nope' })
    const unknown = await registry.dispatch({ id: '4', tool: 'demo.missing' }, 'dev')
    expect(unknown.ok).toBe(false)
    expect(!unknown.ok && unknown.error).toContain('Unknown tool "demo.missing"')
  })
})

describe('toJson', () => {
  test('breaks cycles and drops functions', () => {
    const a: Record<string, unknown> = { n: 1, fn: () => 1, big: 10n, set: new Set([1]) }
    a.self = a
    expect(toJson(a)).toEqual({ n: 1, big: '10', set: [1], self: '[Circular]' })
    expect(toJson(undefined)).toBeNull()
  })
})
