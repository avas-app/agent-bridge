import { describe, expect, test } from 'bun:test'

import { captureTools, loadViewShot, type ViewShot } from '../tools/capture'

function run(load: () => ViewShot | undefined, options?: unknown) {
  const tool = captureTools(load)['screen.capture']
  const fn = typeof tool === 'function' ? tool : tool?.run
  return fn?.(options)
}

function fake(base64 = 'AAAA') {
  const calls: string[] = []
  const viewShot: ViewShot = {
    captureScreen: async ({ result }) => {
      calls.push(result)
      return result === 'base64' ? base64 : '/tmp/shot.png'
    },
  }
  return { viewShot, calls }
}

describe('screen.capture', () => {
  test('returns a tmpfile path', async () => {
    const { viewShot, calls } = fake()
    expect(await run(() => viewShot)).toEqual({ path: '/tmp/shot.png' })
    expect(calls).toEqual(['tmpfile'])
  })

  test('returns base64 on request when small', async () => {
    const { viewShot } = fake()
    expect(await run(() => viewShot, { base64: true })).toEqual({
      base64: 'AAAA',
    })
  })

  test('falls back to a path when base64 is too big', async () => {
    const { viewShot, calls } = fake('A'.repeat(300_000))
    expect(await run(() => viewShot, { base64: true })).toEqual({
      path: '/tmp/shot.png',
    })
    expect(calls).toEqual(['base64', 'tmpfile'])
  })

  test('errors with alternatives when view-shot is absent', async () => {
    const error = await Promise.resolve(run(() => undefined)).catch(
      (e: Error) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('agent-device')
    expect((error as Error).message).toContain('screencap')
    expect((error as Error).message).not.toContain('install')
  })

  test('loadViewShot is undefined when the package is missing', () => {
    expect(loadViewShot()).toBeUndefined()
  })
})
