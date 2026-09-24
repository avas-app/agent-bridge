import type { Tools } from '../runtime/types'

/** The MMKV surface this adapter uses. v3 has `delete`, v4 has `remove`. */
export type MMKVLike = {
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
        return true
      },
    },
    'mmkv.delete': {
      description: 'Delete a key.',
      run: (name: string, key: string) => {
        const mmkv = get(name)
        beforeChange(mmkv, key)
        remove(mmkv, name, key)
        return true
      },
    },
    'mmkv.restore': {
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
        }
        return restored
      },
    },
  }
}
