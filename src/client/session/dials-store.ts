// <project>/.agent-bridge/dials.json: the picks that outlive a session.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { isAlive } from './state'

export type DialValue = unknown

/** What a dial looks like on the wire (the fields the store and CLI read). */
export type DialInfo = {
  id: string
  type: string
  value: DialValue
  original: DialValue
  label?: string
  group?: string
  desc?: string
  screens?: string[]
  onScreen?: boolean
  min?: number
  max?: number
  step?: number
  options?: unknown[]
  tokenPath?: string
  renders?: number
}

export type SavedDial = {
  value: DialValue
  original: DialValue
  type: string
  history: DialValue[]
  updatedAt: number
}

export type DialsFile = Record<string, SavedDial>

export type CommitStatus = 'requested' | 'taken' | 'writing' | 'done' | 'failed' | 'cancelled'

export const inFlight = (commit: CommitRequest | null) =>
  !!commit && ['requested', 'taken', 'writing'].includes(commit.status)

export type CommitRequest = {
  id: string
  ids: string[]
  note?: string
  revertOthers: boolean
  values: Record<
    string,
    {
      value: DialValue
      original: DialValue
      type: string
      source?: { file: string; line: number }
    }
  >
  status: CommitStatus
  message?: string
  at: number
}

/** The commit request lives in dials.json beside the dial entries, under this key. */
export const COMMIT_KEY = 'commit'

export const HISTORY_CAP = 20

export const dialsPath = (project: string) =>
  join(project, '.agent-bridge', 'dials.json')

const waitersDir = (project: string) => join(project, '.agent-bridge', 'dials-waiters')

/** A waiter whose file wasn't refreshed for this long is gone (killed, or its pid reused). */
export const WAITER_STALE_MS = 3000

/** Marks that `dials wait` is listening in this process. Call `beat` while waiting and `unmark` when done. */
export function markWaiter(project: string): { beat: () => void; unmark: () => void } {
  const file = join(waitersDir(project), String(process.pid))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '')
  return {
    beat: () => {
      try {
        const now = new Date()
        utimesSync(file, now, now)
      } catch {
        try {
          writeFileSync(file, '')
        } catch {}
      }
    },
    unmark: () => rmSync(file, { force: true }),
  }
}

/** Whether a live `dials wait` is listening for this project's commits. */
export function agentWaiting(project: string, now = Date.now()): boolean {
  let names: string[]
  try {
    names = readdirSync(waitersDir(project))
  } catch {
    return false
  }
  return names.some((name) => {
    const file = join(waitersDir(project), name)
    try {
      if (now - statSync(file).mtimeMs < WAITER_STALE_MS && isAlive(Number(name))) return true
    } catch {
      return false
    }
    rmSync(file, { force: true })
    return false
  })
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function readRaw(project: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(dialsPath(project), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function readDials(project: string): DialsFile {
  const { [COMMIT_KEY]: _commit, ...dials } = readRaw(project)
  return dials as DialsFile
}

export function readCommit(project: string): CommitRequest | null {
  const commit = readRaw(project)[COMMIT_KEY] as CommitRequest | undefined
  return commit && typeof commit === 'object' && typeof commit.status === 'string' ? commit : null
}

function writeRaw(project: string, data: Record<string, unknown>) {
  const file = dialsPath(project)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`)
    renameSync(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
}

const LOCK_STALE_MS = 10_000
const LOCK_GIVE_UP_MS = 5_000
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Runs `fn` while holding <dials.json>.lock, so read-modify-write cycles from several processes don't interleave. */
export function withDialsLock<T>(project: string, fn: () => T): T {
  const lock = `${dialsPath(project)}.lock`
  mkdirSync(dirname(lock), { recursive: true })
  const started = Date.now()
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        // A holder that died leaves the file behind; critical sections take milliseconds.
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true })
      } catch {}
      if (Date.now() - started > LOCK_GIVE_UP_MS) rmSync(lock, { force: true })
      pause(5)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

/** Re-reads the dial entries inside the lock, lets `fn` change them, and writes them with the commit request kept. */
export function updateDials(project: string, fn: (saved: DialsFile) => DialsFile): DialsFile {
  return withDialsLock(project, () => {
    const next = fn(readDials(project))
    const commit = readCommit(project)
    if (commit || Object.keys(next).length) writeRaw(project, commit ? { ...next, [COMMIT_KEY]: commit } : next)
    else rmSync(dialsPath(project), { force: true })
    return next
  })
}

/** Writes the dial entries and keeps the commit request that sits in the same file. */
export function writeDials(project: string, dials: DialsFile) {
  updateDials(project, () => dials)
}

/**
 * Reads the commit request inside the lock; `fn` returns the new one (null removes it,
 * undefined leaves the file alone). Returns what `fn` returned.
 */
export function updateCommit(
  project: string,
  fn: (commit: CommitRequest | null) => CommitRequest | null | undefined,
): CommitRequest | null | undefined {
  return withDialsLock(project, () => {
    const next = fn(readCommit(project))
    if (next === undefined) return undefined
    const dials = readDials(project)
    if (next) writeRaw(project, { ...dials, [COMMIT_KEY]: next })
    else if (Object.keys(dials).length) writeRaw(project, dials)
    else rmSync(dialsPath(project), { force: true })
    return next
  })
}

/** Sets or (with null) removes the commit request; the dial entries stay. */
export function writeCommit(project: string, commit: CommitRequest | null) {
  updateCommit(project, () => commit)
}

/** Moves a requested commit to taken. Null when none is waiting, so two waiters never both get it. */
export function takeCommit(project: string): CommitRequest | null {
  const taken = updateCommit(project, (c) => (c?.status === 'requested' ? { ...c, status: 'taken' } : undefined))
  return taken ?? null
}

/** Cancels a commit that has not finished (the agent died, or the user changed their mind). Null when none is in flight. */
export function cancelCommit(project: string): CommitRequest | null {
  const next = updateCommit(project, (c) => (c && inFlight(c) ? { ...c, status: 'cancelled' } : undefined))
  return next ?? null
}

/**
 * Folds the app's dials into `saved`. A dial at its original value with no
 * entry is not saved. Returns the new file and whether anything changed.
 */
export function mergeDials(
  saved: DialsFile,
  dials: DialInfo[],
  now = Date.now(),
): { next: DialsFile; changed: boolean } {
  const next: DialsFile = { ...saved }
  let changed = false
  for (const dial of dials) {
    const old = saved[dial.id]
    if (!old && same(dial.value, dial.original)) continue
    if (old && same(old.value, dial.value) && old.type === dial.type) continue
    // The first change's previous value is the original.
    const history = old ? [...old.history, old.value] : [dial.original]
    next[dial.id] = {
      value: dial.value,
      original: old?.original ?? dial.original,
      type: dial.type,
      history: history.slice(-HISTORY_CAP),
      updatedAt: now,
    }
    changed = true
  }
  return { next, changed }
}

/** Removes entries (all with no ids). Returns the ids removed. */
export function clearDials(project: string, ids: string[] = []): string[] {
  let gone: string[] = []
  updateDials(project, (saved) => {
    gone = ids.length ? ids.filter((id) => id in saved) : Object.keys(saved)
    const next = { ...saved }
    for (const id of gone) delete next[id]
    return next
  })
  return gone
}

/** id -> value, the argument of dial.apply. */
export const savedValues = (saved: DialsFile): Record<string, DialValue> =>
  Object.fromEntries(Object.entries(saved).map(([id, d]) => [id, d.value]))

export const hasSavedDials = (project: string) =>
  existsSync(dialsPath(project)) && Object.keys(readDials(project)).length > 0

/**
 * Collects dial changes and writes them at most every `throttleMs`, with a trailing write.
 * Only the ids a call names are kept; the file is re-read inside the lock at write time.
 */
export function createDialsStore(project: string, throttleMs = 250) {
  const pending: DialInfo[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastWrite = 0
  const write = () => {
    clearTimeout(timer)
    timer = undefined
    if (!pending.length) return
    const batch = pending.splice(0)
    lastWrite = Date.now()
    try {
      // One merge per recorded value, so a throttled burst still lands in the history.
      updateDials(project, (saved) => batch.reduce((acc, dial) => mergeDials(acc, [dial]).next, saved))
    } catch {
      pending.unshift(...batch)
    }
  }
  return {
    record(dials: DialInfo[], ids: string[]) {
      const mine = dials.filter((dial) => ids.includes(dial.id))
      pending.push(...mine)
      if (!mine.length || timer) return
      const wait = Math.max(0, lastWrite + throttleMs - Date.now())
      timer = setTimeout(write, wait)
      ;(timer as { unref?: () => void }).unref?.()
    },
    flush: write,
  }
}
