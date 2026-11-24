import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HISTORY_CAP,
  clearDials,
  createDialsStore,
  dialsPath,
  mergeDials,
  readDials,
  writeDials,
} from '../dials-store'

const dial = (id: string, value: unknown, original: unknown = 0) => ({ id, type: 'number', value, original })

let project = ''
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dials-store-'))
})
afterEach(() => rmSync(project, { recursive: true, force: true }))

describe('mergeDials', () => {
  test('skips a dial still at its original, saves a changed one with its history', () => {
    const first = mergeDials({}, [dial('a', 0), dial('b', 5)], 10)
    expect(Object.keys(first.next)).toEqual(['b'])
    const second = mergeDials(first.next, [dial('b', 7)], 20)
    expect(second.next.b).toEqual({ value: 7, original: 0, type: 'number', history: [5], updatedAt: 20 })
    expect(mergeDials(second.next, [dial('b', 7)]).changed).toBe(false)
  })

  test('keeps entries for dials the app no longer lists', () => {
    const { next } = mergeDials({ gone: { value: 1, original: 0, type: 'number', history: [], updatedAt: 1 } }, [dial('b', 2)])
    expect(Object.keys(next).sort()).toEqual(['b', 'gone'])
  })

  test('caps history at the last 20 values', () => {
    let saved = {}
    for (let i = 1; i <= 30; i++) saved = mergeDials(saved, [dial('a', i)]).next
    const entry = (saved as Record<string, { history: number[]; value: number }>).a as { history: number[]; value: number }
    expect(entry.history).toHaveLength(HISTORY_CAP)
    expect(entry.history.at(-1)).toBe(29)
    expect(entry.history[0]).toBe(10)
  })
})

describe('file', () => {
  test('writes atomically and leaves no temp file', () => {
    writeDials(project, mergeDials({}, [dial('a', 3)]).next)
    expect(readDials(project).a?.value).toBe(3)
    expect(readdirSync(join(project, '.agent-bridge'))).toEqual(['dials.json'])
  })

  test('a broken file reads as empty', () => {
    writeDials(project, {})
    Bun.write(dialsPath(project), '{nope')
    expect(readDials(project)).toEqual({})
  })

  test('clear removes some ids, or all and the file', () => {
    writeDials(project, mergeDials({}, [dial('a', 1), dial('b', 2)]).next)
    expect(clearDials(project, ['a', 'zzz'])).toEqual(['a'])
    expect(Object.keys(readDials(project))).toEqual(['b'])
    expect(clearDials(project)).toEqual(['b'])
    expect(existsSync(dialsPath(project))).toBe(false)
  })
})

describe('createDialsStore', () => {
  test('throttles, then writes the last value; flush writes at once', async () => {
    const store = createDialsStore(project, 60)
    store.record([dial('a', 1)])
    await new Promise((r) => setTimeout(r, 20))
    expect(readDials(project).a?.value).toBe(1)
    store.record([dial('a', 2)])
    store.record([dial('a', 3)])
    expect(readDials(project).a?.value).toBe(1)
    await new Promise((r) => setTimeout(r, 120))
    expect(readDials(project).a?.value).toBe(3)
    store.record([dial('a', 4)])
    store.flush()
    expect(readDials(project).a?.value).toBe(4)
  })

  test('a clear between writes is not undone', () => {
    const store = createDialsStore(project, 0)
    store.record([dial('a', 1)])
    store.flush()
    clearDials(project)
    store.record([dial('b', 2)])
    store.flush()
    expect(Object.keys(readDials(project))).toEqual(['b'])
  })
})
