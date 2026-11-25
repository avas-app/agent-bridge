import { beforeEach, expect, mock, test } from 'bun:test'

import { installRefreshRecovery, isHookCountError, resetRecoveryForTests } from '../recover'

const hooks = new Error('Rendered fewer hooks than expected. This may be caused by an accidental early return statement.')

function env() {
  const calls: unknown[][] = []
  let handler: (e: unknown, f?: boolean) => void = (...a) => void calls.push(['previous', ...a])
  const e = {
    ErrorUtils: { getGlobalHandler: () => handler, setGlobalHandler: (h: typeof handler) => (handler = h) },
    console: { error: (...a: unknown[]) => void calls.push(['console', ...a]) },
  }
  return { e, calls, handler: () => handler }
}

beforeEach(resetRecoveryForTests)

test('recognises both hook-count errors only', () => {
  expect(isHookCountError(hooks)).toBe(true)
  expect(isHookCountError(new Error('Rendered more hooks than during the previous render.'))).toBe(true)
  expect(isHookCountError(new Error('boom'))).toBe(false)
  expect(isHookCountError(undefined)).toBe(false)
})

test('a hook-count error through the global handler reloads once and is not passed on', async () => {
  const reload = mock(() => {})
  const { e, calls, handler } = env()
  expect(installRefreshRecovery(e, reload)).toBe(true)
  handler()(hooks, true)
  handler()(hooks, true)
  await new Promise((r) => setTimeout(r, 80))
  expect(reload).toHaveBeenCalledTimes(1)
  expect(calls).toEqual([])
})

test('a hook-count error logged with console.error reloads and still logs', async () => {
  const reload = mock(() => {})
  const { e, calls } = env()
  installRefreshRecovery(e, reload)
  e.console.error('x', hooks)
  await new Promise((r) => setTimeout(r, 80))
  expect(reload).toHaveBeenCalledTimes(1)
  expect(calls).toEqual([['console', 'x', hooks]])
})

test('other errors pass through untouched and install is once-only', async () => {
  const reload = mock(() => {})
  const { e, calls, handler } = env()
  installRefreshRecovery(e, reload)
  expect(installRefreshRecovery(e, reload)).toBe(false)
  const other = new Error('boom')
  handler()(other, false)
  e.console.error(other)
  await new Promise((r) => setTimeout(r, 80))
  expect(reload).not.toHaveBeenCalled()
  expect(calls).toEqual([['previous', other, false], ['console', other]])
})

test('does nothing without ErrorUtils', () => {
  expect(installRefreshRecovery({}, () => {})).toBe(false)
})
