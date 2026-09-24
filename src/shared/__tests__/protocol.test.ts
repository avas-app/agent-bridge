import { describe, expect, test } from 'bun:test'

import { toAsciiJson } from '../protocol'

describe('toAsciiJson', () => {
  test('escapes astral and non-ASCII characters and round-trips', () => {
    const value = { title: `Ride ${String.fromCodePoint(0x1f697)}`, thaana: 'ދިވެހި', plain: 'ok' }
    const json = toAsciiJson(value)
    expect(/^[\x00-\x7e]*$/.test(json)).toBe(true)
    expect(JSON.parse(json)).toEqual(value)
  })
})
