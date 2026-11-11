import type { Tools } from '../runtime/types'

/** The expo-secure-store surface this adapter uses (`import * as SecureStore`). */
export type SecureStoreLike = {
  getItemAsync: (key: string) => Promise<string | null>
  setItemAsync: (key: string, value: string) => Promise<void>
  deleteItemAsync: (key: string) => Promise<void>
}

// Each key's value from before the agent first wrote it (null when it did not
// exist), per store, so tools rebuilt on every render still find it. The
// promise is stored first so two writes to one key can't both snapshot.
const originals = new WeakMap<SecureStoreLike, Map<string, Promise<string | null>>>()

const hide = (value: string | null) =>
  value === null ? null : `[redacted, ${value.length} chars]`

/**
 * Read and write expo-secure-store. Its values are secrets, so reads are
 * redacted unless {full:true}. It cannot list keys: pass the ones the app
 * knows as `keys` to let `secureStore.list` show them.
 */
export function secureStoreTools(
  store: SecureStoreLike,
  keys: readonly string[] = [],
): Tools {
  const beforeChange = async (key: string) => {
    let saved = originals.get(store)
    if (!saved) originals.set(store, (saved = new Map()))
    if (saved.has(key)) return void (await saved.get(key))
    const read = store.getItemAsync(key)
    saved.set(key, read)
    try {
      await read
    } catch (error) {
      saved.delete(key)
      throw error
    }
  }

  return {
    'secureStore.list': {
      description:
        'The keys the app passed to secureStoreTools, each with whether it is set and its length. SecureStore cannot list keys itself: for any other key, call secureStore.get with its name. Values are not shown.',
      run: async () =>
        Object.fromEntries(
          await Promise.all(
            keys.map(async (k) => {
              const v = await store.getItemAsync(k)
              return [k, v === null ? { set: false } : { set: true, length: v.length }]
            }),
          ),
        ),
    },
    'secureStore.get': {
      description:
        'A key\'s value, redacted to its length unless {full:true}; null when missing. Pass the key name: SecureStore has no key listing.',
      run: async (key: string, options?: { full?: boolean }) => {
        const value = await store.getItemAsync(key)
        return options?.full ? value : hide(value)
      },
    },
    'secureStore.set': {
      description:
        'Set a value (a string; other values are stored as JSON). The old value is kept in memory for secureStore.restore.',
      run: async (key: string, value: unknown) => {
        await beforeChange(key)
        await store.setItemAsync(
          key,
          typeof value === 'string' ? value : JSON.stringify(value),
        )
        return true
      },
    },
    'secureStore.delete': {
      description: 'Delete a key.',
      run: async (key: string) => {
        await beforeChange(key)
        await store.deleteItemAsync(key)
        return true
      },
    },
    'secureStore.restore': {
      // Always a plain true: bridge.pending must not show key names or values.
      pending: () => (originals.get(store)?.size ?? 0) > 0,
      description:
        'Undo the agent: put back keys changed with secureStore.set or secureStore.delete, deleting ones that did not exist. Returns how many.',
      run: async () => {
        const saved = originals.get(store)
        if (!saved) return 0
        let restored = 0
        let failed = 0
        for (const [key, pending] of [...saved]) {
          try {
            const value = await pending
            if (value === null) await store.deleteItemAsync(key)
            else await store.setItemAsync(key, value)
            saved.delete(key)
            restored += 1
          } catch {
            failed += 1
          }
        }
        if (failed)
          throw new Error(
            `Restored ${restored}, could not restore ${failed} key(s). They stay pending; run it again.`,
          )
        originals.delete(store)
        return restored
      },
    },
  }
}
