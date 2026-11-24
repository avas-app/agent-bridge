// <project>/.agent-bridge/dials.json: the picks that outlive a session.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export type DialValue = unknown

/** What a dial looks like on the wire (the fields the store and CLI read). */
export type DialInfo = {
  id: string
  type: string
  value: DialValue
  original: DialValue
  label?: string
  group?: string
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

export const HISTORY_CAP = 20

export const dialsPath = (project: string) =>
  join(project, '.agent-bridge', 'dials.json')

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function readDials(project: string): DialsFile {
  try {
    const parsed = JSON.parse(readFileSync(dialsPath(project), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as DialsFile)
      : {}
  } catch {
    return {}
  }
}

export function writeDials(project: string, dials: DialsFile) {
  const file = dialsPath(project)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(dials, null, 2)}\n`)
    renameSync(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
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
    const history = old ? [...old.history, old.value] : []
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
  const saved = readDials(project)
  const gone = ids.length ? ids.filter((id) => id in saved) : Object.keys(saved)
  if (!gone.length) return []
  const next = { ...saved }
  for (const id of gone) delete next[id]
  if (Object.keys(next).length) writeDials(project, next)
  else rmSync(dialsPath(project), { force: true })
  return gone
}

/** id -> value, the argument of dial.apply. */
export const savedValues = (saved: DialsFile): Record<string, DialValue> =>
  Object.fromEntries(Object.entries(saved).map(([id, d]) => [id, d.value]))

export const hasSavedDials = (project: string) =>
  existsSync(dialsPath(project)) && Object.keys(readDials(project)).length > 0

/** Collects dial changes and writes them at most every `throttleMs`, with a trailing write. */
export function createDialsStore(project: string, throttleMs = 250) {
  let current: DialsFile | null = null
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastWrite = 0
  const write = () => {
    clearTimeout(timer)
    timer = undefined
    if (!dirty || !current) return
    dirty = false
    lastWrite = Date.now()
    try {
      writeDials(project, current)
    } catch {
      dirty = true
    }
  }
  return {
    record(dials: DialInfo[]) {
      // A CLI `dials clear` between writes must not be undone by a stale copy.
      if (!dirty || !current) current = readDials(project)
      const { next, changed } = mergeDials(current, dials)
      if (!changed) return
      current = next
      dirty = true
      if (timer) return
      const wait = Math.max(0, lastWrite + throttleMs - Date.now())
      timer = setTimeout(write, wait)
      ;(timer as { unref?: () => void }).unref?.()
    },
    flush: write,
  }
}
