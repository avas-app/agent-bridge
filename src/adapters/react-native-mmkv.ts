import type { AdoptResult, Tools } from '../runtime/types'

/** The MMKV surface this adapter uses. v3 has `delete`, v4 has `remove`. */
export type MMKVLike = {
  /** MMKV v2 and v3 instances carry their `id`; v4 does not. Used only to tell instances apart. */
  id?: string
  getAllKeys: () => string[]
  getString: (key: string) => string | undefined
  set: (key: string, value: string | number | boolean) => void
  contains?: (key: string) => boolean
  delete?: (key: string) => void
  remove?: (key: string) => unknown
}

// Each key's value from before the agent first wrote it (undefined when it
// did not exist), per instance, so tools rebuilt on every render still find it.
const originals = new WeakMap<
  MMKVLike,
  Map<string, string | undefined | null>
>()

// What the agent last wrote per key: a string, null for a delete, 'native' for
// a number or boolean (not journaled: it can't be read back as a string).
const written = new WeakMap<MMKVLike, Map<string, string | null | 'native'>>()
// Module state, not shared: only this adapter's own tools read it.
let rev = 0

type JournalEntry = { original: string | null; written: string | null; id?: string }
type Journal = Record<string, Record<string, JournalEntry>>

const idOf = (mmkv: MMKVLike) => (typeof mmkv.id === 'string' ? mmkv.id : undefined)

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function remove(mmkv: MMKVLike, name: string, key: string) {
  if (mmkv.remove) mmkv.remove(key)
  else if (mmkv.delete) mmkv.delete(key)
  else throw new Error(`MMKV instance "${name}" has neither remove() nor delete()`)
}

/** Read and write named MMKV instances. */
export function mmkvTools(instances: Record<string, MMKVLike>): Tools {
  const get = (name: string) => {
    const mmkv = instances[name]
    if (!mmkv)
      throw new Error(
        `Unknown MMKV instance "${name}". Known: ${Object.keys(instances).join(', ')}`,
      )
    return mmkv
  }
  const beforeChange = (mmkv: MMKVLike, key: string) => {
    let saved = originals.get(mmkv)
    if (!saved) originals.set(mmkv, (saved = new Map()))
    if (saved.has(key)) return
    const exists = mmkv.contains?.(key) ?? mmkv.getAllKeys().includes(key)
    // null: the key holds something getString can't read, so leave it be.
    saved.set(key, exists ? (mmkv.getString(key) ?? null) : undefined)
  }

  const note = (mmkv: MMKVLike, key: string, value: string | null | 'native') => {
    let map = written.get(mmkv)
    if (!map) written.set(mmkv, (map = new Map()))
    map.set(key, value)
    rev += 1
  }

  return {
    'mmkv.list': {
      description: 'Instance names.',
      run: () => Object.keys(instances),
    },
    'mmkv.keys': {
      description: 'Keys in an instance.',
      run: (name: string) => get(name).getAllKeys(),
    },
    'mmkv.get': {
      description: 'A string value; parsed as JSON when {json:true}.',
      run: (name: string, key: string, options?: { json?: boolean }) => {
        const raw = get(name).getString(key)
        return options?.json && raw !== undefined ? JSON.parse(raw) : raw
      },
    },
    'mmkv.set': {
      description:
        'Set a value. Objects and arrays are stored as JSON strings.',
      run: (name: string, key: string, value: unknown) => {
        const stored =
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
            ? value
            : JSON.stringify(value)
        const mmkv = get(name)
        beforeChange(mmkv, key)
        mmkv.set(key, stored)
        note(mmkv, key, typeof stored === 'string' ? stored : 'native')
        return true
      },
    },
    'mmkv.delete': {
      description: 'Delete a key.',
      run: (name: string, key: string) => {
        const mmkv = get(name)
        beforeChange(mmkv, key)
        remove(mmkv, name, key)
        note(mmkv, key, null)
        return true
      },
    },
    'mmkv.restore': {
      pending: () => Object.values(instances).some((m) => originals.has(m)),
      journalRev: () => rev,
      // Only string values: an original or written number can't be read back as one.
      journal: (): Journal | undefined => {
        const out: Journal = {}
        for (const [name, mmkv] of Object.entries(instances)) {
          const saved = originals.get(mmkv)
          for (const [key, original] of saved ?? []) {
            const now = written.get(mmkv)?.get(key)
            if (original === null || now === undefined || now === 'native') continue
            const id = idOf(mmkv)
            ;(out[name] ??= {})[key] = { original: original ?? null, written: now, ...(id !== undefined && { id }) }
          }
        }
        return Object.keys(out).length ? out : undefined
      },
      adopt: (raw: unknown): AdoptResult => {
        const data = (isPlain(raw) ? raw : {}) as Journal
        const result: AdoptResult = { adopted: [], already: [], changed: [] }
        const retry: Journal = {}
        for (const [name, keys] of Object.entries(data)) {
          if (!isPlain(keys)) {
            (result.invalid ??= []).push(name)
            continue
          }
          const mmkv = instances[name]
          if (!mmkv) {
            retry[name] = keys
            continue
          }
          for (const [key, entry] of Object.entries(keys)) {
            const label = `${name}:${key}`
            const e = entry as Partial<JournalEntry> | null
            const text = (v: unknown) => v === null || typeof v === 'string'
            if (!isPlain(e) || !text(e.original) || !text(e.written) || (e.id !== undefined && typeof e.id !== 'string')) {
              (result.invalid ??= []).push(label)
              continue
            }
            const now = idOf(mmkv)
            if (e.id !== undefined && now !== undefined && e.id !== now) {
              (result.skipped ??= []).push(label)
              continue
            }
            const exists = mmkv.contains?.(key) ?? mmkv.getAllKeys().includes(key)
            // An absent key proves nothing about a delete unless the same instance is confirmed.
            if (!exists && e.written === null && !(e.id !== undefined && e.id === now)) {
              result.already.push(label)
              continue
            }
            const current = exists ? (mmkv.getString(key) ?? undefined) : null
            // The new load may already have saved the agent's value as the original.
            const saved = originals.get(mmkv)
            const savedNow = saved?.get(key)
            // A delete (written null) matches any key the new load saved as absent, so it needs the same instance confirmed.
            const savedFake =
              saved?.has(key) &&
              savedNow !== null &&
              (savedNow ?? null) === entry.written &&
              (entry.written !== null || (e.id !== undefined && e.id === now))
            if (current === entry.original && !savedFake) {
              result.already.push(label)
            } else if (savedFake || current === entry.written) {
              let map = originals.get(mmkv)
              if (!map) originals.set(mmkv, (map = new Map()))
              map.set(key, entry.original ?? undefined)
              // The new load may have saved a newer value of its own: keep what it wrote.
              if (!savedFake) note(mmkv, key, entry.written)
              else rev += 1
              result.adopted.push(label)
            } else result.changed.push(label)
          }
        }
        if (Object.keys(retry).length) result.retry = retry
        return result
      },
      description:
        'Undo the agent: put back keys changed with mmkv.set or mmkv.delete, deleting ones that did not exist. Returns how many.',
      run: () => {
        let restored = 0
        for (const [name, mmkv] of Object.entries(instances)) {
          const saved = originals.get(mmkv)
          if (!saved) continue
          for (const [key, value] of saved) {
            if (value === null) continue
            if (value === undefined) remove(mmkv, name, key)
            else mmkv.set(key, value)
            restored += 1
          }
          originals.delete(mmkv)
          written.delete(mmkv)
        }
        rev += 1
        return restored
      },
    },
  }
}
