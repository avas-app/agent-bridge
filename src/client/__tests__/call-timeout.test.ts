import { expect, test } from 'bun:test'

import { callTimeout } from '../call-timeout'

test('keeps the base unless a wait tool asks to wait longer', () => {
  expect(callTimeout(10_000, 'screen.waitFor', [])).toBe(10_000)
  expect(callTimeout(10_000, 'screen.waitFor', ['Go'])).toBe(10_000)
  expect(callTimeout(10_000, 'screen.waitFor', ['Go', { timeoutMs: 3000 }])).toBe(10_000)
  expect(callTimeout(10_000, 'screen.waitFor', ['Go', { timeoutMs: 15_000 }])).toBe(17_000)
  expect(callTimeout(10_000, 'screen.waitFor', ['Go', { timeoutMs: 'soon' }])).toBe(10_000)
})

test('webview.waitFor gets a margin past the page helper\'s own 5 s', () => {
  expect(callTimeout(10_000, 'webview.waitFor', ['x', { timeoutMs: 15_000 }])).toBe(22_000)
})

test('other tools keep the base, even with a timeoutMs argument', () => {
  expect(callTimeout(10_000, 'store.set', [{ timeoutMs: 60_000 }])).toBe(10_000)
  expect(callTimeout(10_000, 'mmkv.set', ['k', { timeoutMs: 60_000 }])).toBe(10_000)
})

test('huge, zero and negative values are clamped or ignored', () => {
  const huge = callTimeout(10_000, 'screen.waitFor', ['x', { timeoutMs: 2 ** 40 }])
  expect(huge).toBeLessThanOrEqual(2 ** 31 - 1)
  expect(huge).toBeGreaterThan(10_000)
  expect(callTimeout(10_000, 'screen.waitFor', ['x', { timeoutMs: Infinity }])).toBe(10_000)
  expect(callTimeout(10_000, 'screen.waitFor', ['x', { timeoutMs: 0 }])).toBe(10_000)
  expect(callTimeout(10_000, 'screen.waitFor', ['x', { timeoutMs: -5 }])).toBe(10_000)
})
