import type { Tools } from '../runtime/types'
import { type KeyUndo, change, describeRestore, restore, toStored } from './storage-undo'

/** The options expo-secure-store takes on every call. */
export type SecureStoreOptions = {
  keychainService?: string
  keychainAccessible?: number
  requireAuthentication?: boolean
  authenticationPrompt?: string
  accessGroup?: string
}

/** The expo-secure-store surface this adapter uses (`import * as SecureStore`). */
export type SecureStoreLike = {
  getItemAsync: (key: string, options?: SecureStoreOptions) => Promise<string | null>
  setItemAsync: (key: string, value: string, options?: SecureStoreOptions) => Promise<void>
  deleteItemAsync: (key: string, options?: SecureStoreOptions) => Promise<void>
}

/** One options object for every key, or a function that picks them per key. */
export type SecureStoreOptionsFor =
  | SecureStoreOptions
  | ((key: string) => SecureStoreOptions | undefined)

// Pending changes per store, so tools rebuilt on every render still find them.
const originals = new WeakMap<SecureStoreLike, KeyUndo>()

const hide = (value: string | null) =>
  value === null ? null : `[redacted, ${value.length} chars]`

/**
 * Read and write expo-secure-store. Its values are secrets, so reads are
 * redacted unless {full:true}. It cannot list keys: pass the ones the app
 * knows as `keys` to let `secureStore.list` show them. `options` must match
 * what the app passes (a `keychainService` picks a different item), as one
 * object or a function of the key.
 */
export function secureStoreTools(
  store: SecureStoreLike,
  keys: readonly string[] = [],
  options?: SecureStoreOptionsFor,
): Tools {
  let undo = originals.get(store)
  if (!undo) originals.set(store, (undo = new Map()))
  const pending = undo

  const optionsFor = (key: string) =>
    typeof options === 'function' ? options(key) : options
  // Items the app protects with a biometric prompt: reading one prompts the user.
  const guarded = (key: string) => optionsFor(key)?.requireAuthentication === true
  // The same item under two services or access groups is two items.
  const idOf = (key: string) => {
    const o = optionsFor(key)
    return JSON.stringify([o?.keychainService ?? '', o?.accessGroup ?? '', key])
  }
  const apply = async (key: string, value: string | null) => {
    const o = optionsFor(key)
    const io = {
      read: () => store.getItemAsync(key, o),
      write: (v: string) => store.setItemAsync(key, v, o),
      remove: () => store.deleteItemAsync(key, o),
    }
    try {
      await change(pending, idOf(key), io, value)
    } catch (error) {
      // The first change reads the old value; with a prompt that can fail on its own.
      if (guarded(key) && !pending.has(idOf(key)))
        throw new Error(
          `Could not read the protected key "${key}" to save its old value (${error instanceof Error ? error.message : String(error)}); nothing was changed.`,
        )
      throw error
    }
  }

  return {
    'secureStore.list': {
      description:
        'The keys the app passed to secureStoreTools, each with whether it is set and its length. Keys the app protects with requireAuthentication are not read (they would prompt): they show {authRequired:true}. SecureStore cannot list keys itself: for any other key, call secureStore.get with its name. Values are not shown.',
      run: async () =>
        Object.fromEntries(
          await Promise.all(
            keys.map(async (k) => {
              if (guarded(k)) return [k, { authRequired: true }]
              const v = await store.getItemAsync(k, optionsFor(k))
              return [k, v === null ? { set: false } : { set: true, length: v.length }]
            }),
          ),
        ),
    },
    'secureStore.get': {
      description:
        'A key\'s value, redacted to its length unless {full:true}; null when missing. Pass the key name: SecureStore has no key listing.',
      run: async (key: string, getOptions?: { full?: boolean }) => {
        const value = await store.getItemAsync(key, optionsFor(key))
        return getOptions?.full ? value : hide(value)
      },
    },
    'secureStore.set': {
      description:
        'Set a value (a string; other values are stored as JSON). The old value is kept in memory for secureStore.restore.',
      run: async (key: string, value: unknown) => {
        await apply(key, toStored('secureStore.set', key, value))
        return true
      },
    },
    'secureStore.delete': {
      description: 'Delete a key.',
      run: async (key: string) => {
        if (typeof key !== 'string' || !key)
          throw new Error('secureStore.delete needs the key name as a non-empty string')
        await apply(key, null)
        return true
      },
    },
    'secureStore.restore': {
      // Always a plain true: bridge.pending must not show key names or values.
      pending: () => pending.size > 0,
      description:
        'Undo the agent: put back keys changed with secureStore.set or secureStore.delete (with the same options), deleting ones that did not exist. Returns how many; a key the app has written since is left alone and returned in {skipped}. Lost when the JS reloads: restore before app.reload.',
      run: async () =>
        describeRestore(
          await restore(pending, (id) => (JSON.parse(id) as string[])[2] as string),
          'Those keys',
        ),
    },
  }
}
