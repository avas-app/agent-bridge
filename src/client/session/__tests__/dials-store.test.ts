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
  readCommit,
  readDials,
  takeCommit,
  updateCommit,
  writeCommit,
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
    expect(first.next.b?.history).toEqual([0])
    const second = mergeDials(first.next, [dial('b', 7)], 20)
    expect(second.next.b).toEqual({ value: 7, original: 0, type: 'number', history: [0, 5], updatedAt: 20 })
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
    store.record([dial('a', 1)], ['a'])
    await new Promise((r) => setTimeout(r, 20))
    expect(readDials(project).a?.value).toBe(1)
    store.record([dial('a', 2)], ['a'])
    store.record([dial('a', 3)], ['a'])
    expect(readDials(project).a?.value).toBe(1)
    await new Promise((r) => setTimeout(r, 120))
    expect(readDials(project).a?.value).toBe(3)
    store.record([dial('a', 4)], ['a'])
    store.flush()
    expect(readDials(project).a?.value).toBe(4)
  })

  test('a clear between writes is not undone', () => {
    const store = createDialsStore(project, 0)
    store.record([dial('a', 1)], ['a'])
    store.flush()
    clearDials(project)
    store.record([dial('b', 2)], ['b'])
    store.flush()
    expect(Object.keys(readDials(project))).toEqual(['b'])
  })
})

describe('commit request', () => {
  const commit = {
    id: 'c1',
    ids: ['a'],
    revertOthers: false,
    values: { a: { value: 3, original: 0, type: 'number' } },
    status: 'requested' as const,
    at: 1,
  }

  test('sits beside the dials, survives writes and clear, is not a dial', () => {
    writeDials(project, mergeDials({}, [dial('a', 3)]).next)
    writeCommit(project, commit)
    expect(Object.keys(readDials(project))).toEqual(['a'])
    writeDials(project, mergeDials(readDials(project), [dial('a', 4)]).next)
    expect(readCommit(project)?.id).toBe('c1')
    clearDials(project)
    expect(readDials(project)).toEqual({})
    expect(readCommit(project)?.status).toBe('requested')
    writeCommit(project, null)
    expect(existsSync(dialsPath(project))).toBe(false)
  })
})

const request = (status: 'requested' | 'taken', id = 'c1') => ({
  id,
  ids: ['a'],
  revertOthers: false,
  values: {},
  status,
  at: 1,
})

describe('only the ids a call changed are saved (finding 1)', () => {
  test('a restored list does not overwrite other saved picks', () => {
    const saved = mergeDials({}, [dial('a', 5), dial('b', 7)], 1).next
    // dial.restore put both back to their originals; the user then moved only c.
    const list = [dial('a', 0), dial('b', 0), dial('c', 3)]
    const dir = project
    writeDials(dir, saved)
    const store = createDialsStore(dir, 0)
    store.record(list, ['c'])
    store.flush()
    const file = readDials(dir)
    expect(file.a?.value).toBe(5)
    expect(file.b?.value).toBe(7)
    expect(file.c?.value).toBe(3)
  })

  test('with no ids nothing is saved', () => {
    const store = createDialsStore(project, 0)
    store.record([dial('a', 9)], [])
    store.flush()
    expect(existsSync(dialsPath(project))).toBe(false)
  })
})

describe('lock (finding 5)', () => {
  test('a pending save keeps a commit written after it', () => {
    const store = createDialsStore(project, 10_000)
    store.record([dial('a', 4)], ['a'])
    store.flush()
    writeCommit(project, request('requested'))
    store.record([dial('a', 6)], ['a'])
    store.flush()
    expect(readCommit(project)?.id).toBe('c1')
    expect(readDials(project).a?.value).toBe(6)
  })

  test('a dials clear between two saves is not undone by a stale copy', () => {
    const store = createDialsStore(project, 10_000)
    store.record([dial('a', 4), dial('b', 5)], ['a', 'b'])
    store.flush()
    store.record([dial('a', 6)], ['a'])
    clearDials(project, ['b'])
    store.flush()
    expect(Object.keys(readDials(project))).toEqual(['a'])
  })

  test('takeCommit takes a requested commit once', () => {
    writeCommit(project, request('requested'))
    expect(takeCommit(project)?.status).toBe('taken')
    expect(takeCommit(project)).toBeNull()
    expect(readCommit(project)?.status).toBe('taken')
  })

  test('updateCommit sees the latest file and leaves no lock behind', () => {
    writeCommit(project, request('requested'))
    updateCommit(project, (c) => (c ? { ...c, status: 'taken' } : undefined))
    expect(readCommit(project)?.status).toBe('taken')
    expect(readdirSync(join(project, '.agent-bridge'))).toEqual(['dials.json'])
  })

  test('a stale lock file from a dead process is taken over', () => {
    writeDials(project, {})
    const lock = `${dialsPath(project)}.lock`
    Bun.write(lock, '')
    const old = new Date(Date.now() - 60_000)
    require('node:fs').utimesSync(lock, old, old)
    writeCommit(project, request('requested'))
    expect(readCommit(project)?.id).toBe('c1')
    expect(existsSync(lock)).toBe(false)
  })
})
