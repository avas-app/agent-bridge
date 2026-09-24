import { describe, expect, test } from 'bun:test'

import { logLine } from '../log-lines'

describe('logLine', () => {
  test('names the tool it happened during or after, first line only', () => {
    expect(
      logLine({ level: 'error', message: 'boom\n  at x', at: 1, during: 'store.call' }),
    ).toBe('! error during store.call: boom')
    expect(logLine({ level: 'error', message: 'late', at: 1, after: 'app.throwLater' })).toBe(
      '! error after app.throwLater: late',
    )
    expect(logLine({ level: 'warn', message: 'early', at: 1 })).toBe('! warn: early')
  })
})
