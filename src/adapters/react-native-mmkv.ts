import type { Tools } from '../runtime/types'

/** The MMKV surface this adapter uses. v3 has `delete`, v4 has `remove`. */
export type MMKVLike = {
  getAllKeys: () => string[]
  getString: (key: string) => string | undefined
  set: (key: string, value: string | number | boolean) => void
  delete?: (key: string) => void
  remove?: (key: string) => unknown
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
        get(name).set(key, stored)
        return true
      },
    },
    'mmkv.delete': {
      description: 'Delete a key.',
      run: (name: string, key: string) => {
        const mmkv = get(name)
        if (mmkv.remove) mmkv.remove(key)
        else if (mmkv.delete) mmkv.delete(key)
        else
          throw new Error(
            `MMKV instance "${name}" has neither remove() nor delete()`,
          )
        return true
      },
    },
  }
}
