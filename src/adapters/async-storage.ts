import type { Tools } from '../runtime/types'

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

// Each key's value from before the agent first wrote it (null when it did not
// exist), per storage, so tools rebuilt on every render still find it. The
// promise is stored first so two writes to one key can't both snapshot.
const originals = new WeakMap<
  AsyncStorageLike,
  Map<string, Promise<string | null>>
>()

const clip = (value: string | null) =>
  value !== null && value.length > VALUE_CHARS
    ? `${value.slice(0, VALUE_CHARS)}… (${value.length} chars)`
    : value

/** Read and write AsyncStorage. Values are returned as they are: wire a storage without secrets. */
export function asyncStorageTools(storage: AsyncStorageLike): Tools {
  const beforeChange = async (key: string) => {
    let saved = originals.get(storage)
    if (!saved) originals.set(storage, (saved = new Map()))
    if (saved.has(key)) return void (await saved.get(key))
    const read = storage.getItem(key)
    saved.set(key, read)
    try {
      await read
    } catch (error) {
      saved.delete(key)
      throw error
    }
  }

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
        await beforeChange(key)
        await storage.setItem(
          key,
          typeof value === 'string' ? value : JSON.stringify(value),
        )
        return true
      },
    },
    'asyncStorage.delete': {
      description: 'Delete a key.',
      run: async (key: string) => {
        await beforeChange(key)
        await storage.removeItem(key)
        return true
      },
    },
    'asyncStorage.restore': {
      pending: () => (originals.get(storage)?.size ?? 0) > 0,
      description:
        'Undo the agent: put back keys changed with asyncStorage.set or asyncStorage.delete, deleting ones that did not exist. Returns how many.',
      run: async () => {
        const saved = originals.get(storage)
        if (!saved) return 0
        let restored = 0
        const failed: string[] = []
        for (const [key, pending] of [...saved]) {
          try {
            const value = await pending
            if (value === null) await storage.removeItem(key)
            else await storage.setItem(key, value)
            saved.delete(key)
            restored += 1
          } catch {
            failed.push(key)
          }
        }
        if (failed.length)
          throw new Error(
            `Restored ${restored}, could not restore: ${failed.join(', ')}. They stay pending; run it again.`,
          )
        originals.delete(storage)
        return restored
      },
    },
  }
}
