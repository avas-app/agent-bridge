import type { Tools } from '../runtime/types'
import { type KeyUndo, change, describeRestore, restore, toStored } from './storage-undo'

/** The AsyncStorage surface this adapter uses. */
export type AsyncStorageLike = {
  getAllKeys: () => Promise<readonly string[]>
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
  multiGet?: (
    keys: readonly string[],
  ) => Promise<readonly (readonly [string, string | null])[]>
}

const LIST_LIMIT = 50
const VALUE_CHARS = 200

// Pending changes per storage, so tools rebuilt on every render still find them.
const originals = new WeakMap<AsyncStorageLike, KeyUndo>()

const clip = (value: string | null) =>
  value !== null && value.length > VALUE_CHARS
    ? `${value.slice(0, VALUE_CHARS)}… (${value.length} chars)`
    : value

/** Read and write AsyncStorage. Values are returned as they are: wire a storage without secrets. */
export function asyncStorageTools(storage: AsyncStorageLike): Tools {
  let undo = originals.get(storage)
  if (!undo) originals.set(storage, (undo = new Map()))
  const pending = undo
  const apply = (key: string, value: string | null) =>
    change(
      pending,
      key,
      {
        read: () => storage.getItem(key),
        write: (v) => storage.setItem(key, v),
        remove: () => storage.removeItem(key),
      },
      value,
    )

  return {
    'asyncStorage.list': {
      description:
        'Keys with their values, cut to 200 characters. {limit} (default 50) caps the rows, {prefix} filters keys. Returns {total, keys}.',
      run: async (options?: { limit?: number; prefix?: string }) => {
        const all = (await storage.getAllKeys()).filter(
          (k) => !options?.prefix || k.startsWith(options.prefix),
        )
        const shown = all.slice(0, options?.limit ?? LIST_LIMIT)
        const rows = storage.multiGet
          ? await storage.multiGet(shown)
          : await Promise.all(
              shown.map(async (k) => [k, await storage.getItem(k)] as const),
            )
        return {
          total: all.length,
          keys: Object.fromEntries(rows.map(([k, v]) => [k, clip(v)])),
        }
      },
    },
    'asyncStorage.get': {
      description:
        'A key\'s string value (null when missing); parsed as JSON when {json:true}.',
      run: async (key: string, options?: { json?: boolean }) => {
        const raw = await storage.getItem(key)
        return options?.json && raw !== null ? JSON.parse(raw) : raw
      },
    },
    'asyncStorage.set': {
      description:
        'Set a value. Objects, arrays, numbers and booleans are stored as JSON strings.',
      run: async (key: string, value: unknown) => {
        await apply(key, toStored('asyncStorage.set', key, value))
        return true
      },
    },
    'asyncStorage.delete': {
      description: 'Delete a key.',
      run: async (key: string) => {
        if (typeof key !== 'string' || !key)
          throw new Error('asyncStorage.delete needs the key name as a non-empty string')
        await apply(key, null)
        return true
      },
    },
    'asyncStorage.restore': {
      pending: () => pending.size > 0,
      description:
        'Undo the agent: put back keys changed with asyncStorage.set or asyncStorage.delete, deleting ones that did not exist. Returns how many; a key the app has written since is left alone and returned in {skipped}. Lost when the JS reloads: restore before app.reload.',
      run: async () =>
        describeRestore(await restore(pending, (id) => id), 'Those keys'),
    },
  }
}
