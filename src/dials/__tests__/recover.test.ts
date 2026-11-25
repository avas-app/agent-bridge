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

// Installed at t=0, errors arrive after the app has settled.
const settled = () => {
  let t = 0
  return { clock: () => t, later: () => void (t = 10_000) }
}

test('recognises both hook-count errors only', () => {
  expect(isHookCountError(hooks)).toBe(true)
  expect(isHookCountError(new Error('Rendered more hooks than during the previous render.'))).toBe(true)
  expect(isHookCountError(new Error('boom'))).toBe(false)
  expect(isHookCountError(undefined)).toBe(false)
})

test('a hook-count error through the global handler reloads once and is not passed on', async () => {
  const reload = mock(() => {})
  const { e, calls, handler } = env()
  const c = settled()
  expect(installRefreshRecovery(e, reload, c.clock)).toBe(true)
  c.later()
  handler()(hooks, true)
  handler()(hooks, true)
  await new Promise((r) => setTimeout(r, 80))
  expect(reload).toHaveBeenCalledTimes(1)
  expect(calls).toEqual([])
})

test('a hook-count error logged with console.error reloads and still logs', async () => {
  const reload = mock(() => {})
  const { e, calls } = env()
  const c = settled()
  installRefreshRecovery(e, reload, c.clock)
  c.later()
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

test('a hook-count error right after start is shown, not reloaded, so a real hook bug cannot loop', async () => {
  const reload = mock(() => {})
  const { e, calls, handler } = env()
  installRefreshRecovery(e, reload, () => 0)
  handler()(hooks, true)
  e.console.error(hooks)
  await new Promise((r) => setTimeout(r, 80))
  expect(reload).not.toHaveBeenCalled()
  expect(calls).toEqual([['previous', hooks, true], ['console', hooks]])
})
