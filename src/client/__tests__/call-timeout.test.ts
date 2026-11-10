import { expect, test } from 'bun:test'

import { callTimeout } from '../call-timeout'

test('keeps the base unless an argument asks to wait longer', () => {
  expect(callTimeout(10_000, [])).toBe(10_000)
  expect(callTimeout(10_000, [{ text: 'Go' }, 'x', null, 7])).toBe(10_000)
  expect(callTimeout(10_000, [{ text: 'Go' }, { timeoutMs: 3000 }])).toBe(10_000)
  expect(callTimeout(10_000, [{ text: 'Go' }, { timeoutMs: 15_000 }])).toBe(17_000)
  expect(callTimeout(10_000, [{ timeoutMs: 'soon' }])).toBe(10_000)
})
