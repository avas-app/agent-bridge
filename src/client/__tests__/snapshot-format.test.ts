import { describe, expect, test } from 'bun:test'

import { isSnapshotText, withCompactSnapshot } from '../snapshot-format'

describe('withCompactSnapshot', () => {
  test('asks screen.snapshot for text unless a format is given', () => {
    expect(withCompactSnapshot('screen.snapshot', [])).toEqual([{ format: 'text' }])
    expect(withCompactSnapshot('screen.snapshot', [{ all: true }])).toEqual([{ all: true, format: 'text' }])
    expect(withCompactSnapshot('screen.snapshot', [{ format: 'json' }])).toEqual([{ format: 'json' }])
  })
  test('--json asks for json', () => {
    expect(withCompactSnapshot('screen.snapshot', [], true)).toEqual([{ format: 'json' }])
  })
  test('--json with an explicit text format is an error', () => {
    expect(() => withCompactSnapshot('screen.snapshot', [{ format: 'text' }], true)).toThrow('drop one')
    expect(withCompactSnapshot('screen.snapshot', [{ format: 'text' }])).toEqual([{ format: 'text' }])
  })
  test('leaves other tools and odd arguments alone', () => {
    expect(withCompactSnapshot('screen.press', ['x'])).toEqual(['x'])
    expect(withCompactSnapshot('screen.snapshot', ['x'])).toEqual(['x'])
    expect(withCompactSnapshot('screen.snapshot', [{}, 1])).toEqual([{}, 1])
  })
  test('only a snapshot string prints raw', () => {
    expect(isSnapshotText('screen.snapshot', 'a')).toBe(true)
    expect(isSnapshotText('demo.echo', 'a')).toBe(false)
  })
})
