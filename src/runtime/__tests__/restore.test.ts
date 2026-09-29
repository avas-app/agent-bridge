import { afterEach, describe, expect, test } from 'bun:test'

import { createRegistry } from '../registry'
import { appTools } from '../tools/app'
import { restoreTools } from '../tools/restore'
import { onRestore, resetUndos } from '../undo'
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

describe('app tool undo (onRestore)', () => {
  afterEach(resetUndos)
  const host = { fetchUser: () => 'real' }
  const setup = () => {
    const all: Tools = {
      ...appTools(() => {}),
      ...restoreTools(() => all),
      'host.mockMethod': (value: string) => {
        const original = host.fetchUser
        host.fetchUser = () => value
        onRestore(() => {
          host.fetchUser = original
        }, 'host.fetchUser')
      },
      'store.restore': { run: () => 'store', pending: () => ({ auth: { changed: 1 } }) },
    }
    const registry = createRegistry(() => all)
    const call = async (tool: string, ...args: unknown[]) => {
      const r = await registry.dispatch({ id: '1', tool, args } as never, 'd')
      if (!r.ok) throw new Error(r.error)
      return r.value
    }
    return call
  }

  test('bridge.restore runs a registered undo once, and bridge.pending lists it until then', async () => {
    const call = setup()
    expect(await call('bridge.pending')).toEqual({ store: { auth: { changed: 1 } } })
    await call('host.mockMethod', 'fake')
    expect(host.fetchUser()).toBe('fake')
    expect(await call('bridge.pending')).toEqual({
      app: ['host.fetchUser'],
      store: { auth: { changed: 1 } },
    })

    expect(await call('bridge.restore')).toMatchObject({ 'app.restore': { undone: 1 } })
    expect(host.fetchUser()).toBe('real')
    expect(await call('bridge.pending')).toEqual({ store: { auth: { changed: 1 } } })
    // Not again.
    expect(await call('bridge.restore')).toMatchObject({ 'app.restore': { undone: 0 } })
  })

  test('undoes newest first and reports a failing undo without skipping the others', async () => {
    const order: string[] = []
    onRestore(() => order.push('first'))
    onRestore(() => {
      throw new Error('boom')
    }, 'second')
    onRestore(() => order.push('third'))
    const result = await setup()('bridge.restore')
    expect(order).toEqual(['third', 'first'])
    expect(result).toMatchObject({ 'app.restore': { error: 'second: boom' } })
  })
})
