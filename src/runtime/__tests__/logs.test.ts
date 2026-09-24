import { describe, expect, test } from 'bun:test'

import {
  createLogCapture,
  formatArgs,
  installLogHooks,
  type LogEnv,
  startLogCapture,
} from '../logs'
import { createRegistry } from '../registry'

type Handler = (error: unknown, isFatal?: boolean) => void

/** A console, ErrorUtils and window stand-in that remembers what reached them. */
function fakeEnv() {
  const printed: Array<[string, unknown[]]> = []
  const handled: unknown[] = []
  let handler: Handler = (error) => {
    handled.push(error)
    // React Native's handler feeds the error back into console.error.
    env.console.error(error)
  }
  const listeners = new Map<string, Set<(event: never) => void>>()
  const env = {
    console: {
      error: (...args: unknown[]) => printed.push(['error', args]),
      warn: (...args: unknown[]) => printed.push(['warn', args]),
    },
    ErrorUtils: {
      getGlobalHandler: () => handler,
      setGlobalHandler: (h: Handler) => {
        handler = h
      },
    },
    addEventListener: (type: string, fn: (event: never) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)?.add(fn)
    },
    removeEventListener: (type: string, fn: (event: never) => void) =>
      listeners.get(type)?.delete(fn),
    emit: (type: string, event: unknown) => {
      for (const fn of listeners.get(type) ?? []) fn(event as never)
    },
    listenerCount: () =>
      [...listeners.values()].reduce((n, set) => n + set.size, 0),
  }
  return { env, printed, handled, throwGlobal: (e: unknown) => handler(e, true) }
}

describe('installLogHooks', () => {
  test('records console errors and warnings and still prints them', () => {
    const { env, printed } = fakeEnv()
    const capture = createLogCapture()
    installLogHooks(capture, env)
    env.console.error('bad %s', 'thing', { n: 1 })
    env.console.warn('careful')
    expect(capture.read()).toMatchObject([
      { level: 'error', message: 'bad thing {"n":1}' },
      { level: 'warn', message: 'careful' },
    ])
    expect(printed).toEqual([
      ['error', ['bad %s', 'thing', { n: 1 }]],
      ['warn', ['careful']],
    ])
  })

  test('records a global error once, then calls the original handler', () => {
    const { env, handled, printed, throwGlobal } = fakeEnv()
    const capture = createLogCapture()
    installLogHooks(capture, env)
    const error = new Error('boom from a timer')
    throwGlobal(error)
    expect(handled).toEqual([error])
    expect(printed).toHaveLength(1)
    const entries = capture.read()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'error',
      message: 'Error: boom from a timer',
    })
    expect(entries[0]?.stack).toContain('boom from a timer')
  })

  test('records window error and unhandledrejection events', () => {
    const { env } = fakeEnv()
    const capture = createLogCapture()
    installLogHooks(capture, env)
    env.emit('error', { error: new TypeError('x is undefined') })
    env.emit('unhandledrejection', { reason: 'nope' })
    expect(capture.read().map((e) => e.message)).toEqual([
      'TypeError: x is undefined',
      'Unhandled promise rejection: nope',
    ])
  })

  test('never recurses when recording itself logs', () => {
    const { env } = fakeEnv()
    const capture = createLogCapture()
    const record = capture.record
    capture.record = (level, args) => {
      env.console.error('from inside record')
      record(level, args)
    }
    installLogHooks(capture, env)
    env.console.error('outer')
    expect(capture.read().map((e) => e.message)).toEqual(['outer'])
  })

  test('stop puts back the originals', () => {
    const { env } = fakeEnv()
    const { error, warn } = env.console
    const handler = env.ErrorUtils.getGlobalHandler()
    const stop = installLogHooks(createLogCapture(), env)
    expect(env.console.error).not.toBe(error)
    expect(env.listenerCount()).toBe(2)
    stop()
    expect(env.console.error).toBe(error)
    expect(env.console.warn).toBe(warn)
    expect(env.ErrorUtils.getGlobalHandler()).toBe(handler)
    expect(env.listenerCount()).toBe(0)
  })

  test('leaves a wrapper someone added on top, but stops recording', () => {
    const { env } = fakeEnv()
    const capture = createLogCapture()
    const stop = installLogHooks(capture, env)
    const ours = env.console.error
    const theirs = (...args: unknown[]) => ours(...args)
    env.console.error = theirs
    stop()
    expect(env.console.error).toBe(theirs)
    env.console.error('after stop')
    expect(capture.read()).toEqual([])
  })
})

describe('startLogCapture', () => {
  test('installs once however many bridges start, and uninstalls with the last', () => {
    const { env } = fakeEnv()
    const original = env.console.error
    const a = startLogCapture(env as unknown as LogEnv)
    const wrapped = env.console.error
    const b = startLogCapture(env as unknown as LogEnv)
    expect(env.console.error).toBe(wrapped)
    expect(b.capture).toBe(a.capture)
    env.console.error('once')
    expect(a.capture.read()).toHaveLength(1)
    a.stop()
    a.stop()
    expect(env.console.error).toBe(wrapped)
    b.stop()
    expect(env.console.error).toBe(original)

    // A remount starts again with the same buffer.
    const c = startLogCapture(env as unknown as LogEnv)
    expect(c.capture.read()).toHaveLength(1)
    c.stop()
  })
})

describe('createLogCapture', () => {
  test('tags entries with the running tool, else the last finished one', () => {
    const capture = createLogCapture()
    capture.record('error', ['before any call'])
    const end = capture.begin('store.call')
    capture.record('error', ['inside'])
    end()
    capture.record('warn', ['later'])
    const [before, inside, later] = capture.read()
    expect(before).not.toHaveProperty('during')
    expect(before).not.toHaveProperty('after')
    expect(inside).toMatchObject({ during: 'store.call' })
    expect(inside).not.toHaveProperty('after')
    expect(later).toMatchObject({ after: 'store.call' })
  })

  test('hands each error to one reply, and never warnings', () => {
    const capture = createLogCapture()
    capture.record('error', ['one'])
    capture.record('warn', ['quiet'])
    expect(capture.takeErrors().map((e) => e.message)).toEqual(['one'])
    expect(capture.takeErrors()).toEqual([])
    capture.record('error', ['two'])
    expect(capture.takeErrors().map((e) => e.message)).toEqual(['two'])
    expect(capture.read()).toHaveLength(3)
  })

  test('keeps the last 200 entries', () => {
    const capture = createLogCapture()
    for (let i = 0; i < 250; i++) capture.record('warn', [`w${i}`])
    const entries = capture.read()
    expect(entries).toHaveLength(200)
    expect(entries[0]?.message).toBe('w50')
    expect(entries[199]?.message).toBe('w249')
  })

  test('reads by level and limit, newest last', () => {
    const capture = createLogCapture()
    capture.record('error', ['e1'])
    capture.record('warn', ['w1'])
    capture.record('error', ['e2'])
    expect(capture.read({ level: 'error' }).map((e) => e.message)).toEqual([
      'e1',
      'e2',
    ])
    expect(capture.read({ limit: 2 }).map((e) => e.message)).toEqual([
      'w1',
      'e2',
    ])
  })
})

describe('formatArgs', () => {
  test('uses an Error for the stack, trimmed to 10 lines', () => {
    const error = new Error('deep')
    error.stack = ['Error: deep', ...Array.from({ length: 20 }, (_, i) => `    at f${i}`)].join('\n')
    const { message, stack } = formatArgs(['Failed:', error])
    expect(message).toBe('Failed: Error: deep')
    expect(stack?.split('\n')).toHaveLength(10)
  })

  test('keeps objects short and survives cycles', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(formatArgs([cyclic]).message).toBe('[object Object]')
    expect(formatArgs([{ big: 'x'.repeat(500) }]).message.length).toBeLessThan(210)
    expect(formatArgs(['100%', 'done']).message).toBe('100% done')
  })
})

describe('registry with logs', () => {
  test('attaches errors logged since the previous reply', async () => {
    const capture = createLogCapture()
    const registry = createRegistry(
      () => ({
        'app.logError': (message: string) => capture.record('error', [message]),
        'app.warn': () => capture.record('warn', ['just a warning']),
        'app.fail': () => {
          capture.record('error', ['about to fail'])
          throw new Error('failed')
        },
        'bridge.ping': () => 'pong',
      }),
      capture,
    )
    const logged = await registry.dispatch({ id: '1', tool: 'app.logError', args: ['oops'] }, 'dev')
    expect(logged.logs).toMatchObject([{ level: 'error', message: 'oops', during: 'app.logError' }])

    capture.record('error', ['from a timer'])
    const ping = await registry.dispatch({ id: '2', tool: 'bridge.ping' }, 'dev')
    expect(ping.logs).toMatchObject([{ message: 'from a timer', after: 'app.logError' }])

    expect(await registry.dispatch({ id: '3', tool: 'app.warn' }, 'dev')).not.toHaveProperty('logs')
    const failed = await registry.dispatch({ id: '4', tool: 'app.fail' }, 'dev')
    expect(failed).toMatchObject({ ok: false, logs: [{ message: 'about to fail', during: 'app.fail' }] })
  })
})
