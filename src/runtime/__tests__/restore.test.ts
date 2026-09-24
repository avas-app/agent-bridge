import { describe, expect, test } from 'bun:test'

import { restoreTools } from '../tools/restore'
import type { ToolFn, Tools } from '../types'

const runRestore = (tools: Tools) => {
  const all: Tools = { ...tools, ...restoreTools(() => all) }
  const t = all['bridge.restore']
  return (typeof t === 'function' ? t : (t?.run as ToolFn))()
}

describe('bridge.restore', () => {
  test('runs every *.restore tool in name order, one at a time', async () => {
    const order: string[] = []
    const slow = (name: string, ms: number) => async () => {
      order.push(`${name}:start`)
      await new Promise((r) => setTimeout(r, ms))
      order.push(`${name}:end`)
      return name
    }
    const result = await runRestore({
      'store.restore': { run: slow('store', 1) },
      'app.restore': slow('app', 5),
      'query.restore': () => ({ unpinned: 2 }),
      'query.pin': () => order.push('not a restorer'),
    })
    expect(order).toEqual(['app:start', 'app:end', 'store:start', 'store:end'])
    expect(result).toEqual({ 'app.restore': 'app', 'query.restore': { unpinned: 2 }, 'store.restore': 'store' })
  })

  test('keeps going past a failing restorer and reports its error', async () => {
    const result = await runRestore({
      'a.restore': () => {
        throw new Error('boom')
      },
      'b.restore': async () => Promise.reject('nope'),
      'c.restore': () => 'ok',
    })
    expect(result).toEqual({ 'a.restore': { error: 'boom' }, 'b.restore': { error: 'nope' }, 'c.restore': 'ok' })
  })

  test('does not call itself', async () => {
    expect(await runRestore({})).toEqual({})
  })
})
