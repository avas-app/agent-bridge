import type { AdoptResult, Tools } from '../runtime/types'
import {
  type Redact,
  differences,
  isObject,
  readState,
  redactValue,
} from './store-common'

export type { Redact }

/** Anything with zustand's store shape. */
export type StoreLike = {
  getState: () => unknown
  /**
   * `replace: true` swaps the whole state, as zustand's setState does. Method
   * syntax, so zustand's overloads (replace: false | true) still fit.
   */
  setState(partial: Record<string, unknown>, replace?: boolean): void
  /** Present on stores made with zustand's `persist` middleware. */
  persist?: {
    getOptions?: () => { partialize?: (state: never) => unknown }
    hasHydrated?: () => boolean
    onFinishHydration?: (fn: () => void) => () => void
  }
}

const HYDRATION_WAIT_MS = 2000
// Module state, not shared: only this adapter's own tools read it.
let rev = 0

type Image = Record<string, unknown>
// `original` and `after` hold only the keys the agent changed, as plain JSON;
// `skipped` names changed keys that could not be kept that way.
type StoreJournal = { original: Image; after: Image; skipped?: string[] }

/** True when the value comes back equal from JSON: no Set, Map, Date, class instance or function inside. */
function survivesJson(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (depth > 50 || !isObject(v)) return false
  if (Array.isArray(v)) return v.every((x) => survivesJson(x, depth + 1))
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return false
  return Object.values(v).every((x) => x === undefined || survivesJson(x, depth + 1))
}

// A top-level undefined is an absent key, as in JSON.
const ok = (v: unknown) => v === undefined || survivesJson(v)
const has = (x: Image, k: string) => x[k] !== undefined

/** The persisted keys of a state: what partialize returns, minus functions. */
function persisted(store: StoreLike, state: unknown): { raw: Image; refused: Set<string> } | undefined {
  try {
    const partialize = store.persist?.getOptions?.().partialize
    const part = partialize ? partialize(state as never) : state
    if (!isObject(part) || Array.isArray(part)) return undefined
    const raw = Object.fromEntries(Object.entries(part).filter(([, v]) => typeof v !== 'function'))
    const refused = new Set<string>()
    // A key partialize renames or derives can't be written back to the state under that name.
    if (partialize && isObject(state))
      for (const [k, v] of Object.entries(raw)) if (!(k in state) || !Object.is(state[k], v)) refused.add(k)
    return { raw, refused }
  } catch {
    return undefined
  }
}

const differs = (a: unknown, b: unknown) =>
  ok(a) && ok(b) ? !same(a, b) : !Object.is(a, b)

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown

const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (!isObject(a) || !isObject(b) || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every((k) => same(a[k], b[k]))
}

async function hydrated(store: StoreLike): Promise<boolean> {
  const p = store.persist
  if (!p?.hasHydrated || p.hasHydrated()) return true
  return new Promise((resolve) => {
    const off = p.onFinishHydration?.(() => finish(true))
    const timer = setTimeout(() => finish(false), HYDRATION_WAIT_MS)
    function finish(ok: boolean) {
      clearTimeout(timer)
      off?.()
      resolve(ok)
    }
  })
}

// State from before the agent's first change, per store object, so tools
// rebuilt on every render still find it.
const snapshots = new WeakMap<StoreLike, unknown>()
// Stores whose snapshot came from an adopt: only these keys are the agent's, the rest is the app's.
const adoptedKeys = new WeakMap<StoreLike, Set<string>>()

// Puts the snapshot's data back and drops keys added since. Actions come from
// the current state, so they keep working.
function restore(store: StoreLike, snapshot: unknown, only?: Set<string>) {
  const current = store.getState()
  if (only && isObject(snapshot) && isObject(current)) {
    const next = { ...current }
    for (const k of only) {
      if (k in snapshot) next[k] = snapshot[k]
      else delete next[k]
    }
    store.setState(next, true)
    return
  }
  if (!isObject(snapshot) || !isObject(current)) {
    store.setState(snapshot as Record<string, unknown>, true)
    return
  }
  const actions = Object.fromEntries(
    Object.entries(current).filter(([, v]) => typeof v === 'function'),
  )
  store.setState({ ...snapshot, ...actions }, true)
}
export type StoreToolsOptions = { redact?: Redact }


/** Read, merge into, and call actions on named stores. */
export function storeTools(
  stores: Record<string, StoreLike>,
  options: StoreToolsOptions = {},
): Tools {
  const out = (name: string, value: unknown, path = '') =>
    redactValue(options.redact, name, value, path)
  const get = (name: string) => {
    const store = stores[name]
    if (!store)
      throw new Error(
        `Unknown store "${name}". Known: ${Object.keys(stores).join(', ')}`,
      )
    return store
  }
  // A key whose value, or a path inside it, redact would hide must not leave the app in the journal.
  const hidden = (name: string, k: string, ...values: unknown[]) => {
    const { redact } = options
    if (!redact) return false
    if (typeof redact !== 'function')
      return !!redact[name]?.some((p) => p === k || p.startsWith(`${k}.`) || k.startsWith(`${p}.`))
    return values.some((v) => !same(redactValue(redact, name, v, k), v))
  }
  const beforeChange = (store: StoreLike) => {
    rev += 1
    const only = adoptedKeys.get(store)
    if (only) {
      // The app has had the store since the adopt; from here the whole store is the agent's to undo.
      const next = { ...(store.getState() as Image) }
      const saved = snapshots.get(store) as Image
      for (const k of only) {
        if (k in saved) next[k] = saved[k]
        else delete next[k]
      }
      snapshots.set(store, next)
      adoptedKeys.delete(store)
    } else if (!snapshots.has(store)) snapshots.set(store, store.getState())
  }

  return {
    'store.list': {
      description: 'Store names.',
      maxArgs: 0,
      run: () => Object.keys(stores),
    },
    'store.get': {
      description:
        'State of a store, or a path inside it: ("auth", "auth.isLoggedIn"), ("auth", "auth", "isLoggedIn") or ("auth", ["auth", "isLoggedIn"]). A last { pick: ["a.b", "c"] } returns just those fields; { keys: true } lists keys and their types without values. Paths configured with redact print as "[redacted]".',
      // Redact the whole state first, so paths, pick and keys all see it.
      run: (name: string, ...rest: unknown[]) =>
        readState(out(name, get(name).getState()), rest),
    },
    'store.set': {
      description:
        'Shallow-merge a partial into a store. Returns only the keys you set, with their new values, not the whole store. A store is snapshotted on its first store.set or store.call since the last restore (or store.commit); bridge.restore puts that snapshot back. Changes made before that, e.g. by tapping the UI, are not in it: run store.set <store> {} first to snapshot early, and see bridge.pending.',
      run: (name: string, partial: Record<string, unknown>) => {
        const store = get(name)
        beforeChange(store)
        store.setState(partial)
        const state = store.getState() as Record<string, unknown>
        return out(
          name,
          Object.fromEntries(Object.keys(partial).map((k) => [k, state[k]])),
        )
      },
    },
    'store.call': {
      description:
        'Call an action on a store, e.g. ("settings", "setColorScheme", "dark"). Returns the action\'s return value, or { changed: [keys] } when it returns nothing or the store state. Snapshots the store first, like store.set: the first store.set or store.call since the last restore is the state bridge.restore returns to.',
      run: async (name: string, action: string, ...args: unknown[]) => {
        const store = get(name)
        const fn = (store.getState() as Record<string, unknown>)[action]
        if (typeof fn !== 'function')
          throw new Error(`Store "${name}" has no action "${action}"`)
        beforeChange(store)
        const before = store.getState()
        let result: unknown
        try {
          result = await (fn as (...a: unknown[]) => unknown)(...args)
        } finally {
          // An async action changes the store after the bump above; the journal must see that.
          rev += 1
        }
        const after = store.getState()
        if (result !== undefined && result !== before && result !== after) {
          // An action often returns a piece of its own state; redact that by
          // the path it lives at. A copy or derived value isn't found by
          // identity, so its paths are relative to the result.
          const key = isObject(after)
            ? Object.keys(after).find((k) => after[k] === result)
            : undefined
          return out(name, result, key)
        }
        const a = before as Record<string, unknown>
        const b = after as Record<string, unknown>
        return {
          changed: Object.keys(b).filter(
            (k) => typeof b[k] !== 'function' && !Object.is(a?.[k], b[k]),
          ),
        }
      },
    },
    'store.commit': {
      maxArgs: 1,
      description:
        'Keep a store as it is now: drops its pending snapshot, so bridge.restore leaves it alone and the next store.set or store.call snapshots again from this state. Use it after repairing a value that was already wrong when the snapshot was taken. Returns { store, committed } (committed: false when nothing was pending).',
      run: (name: string) => {
        const store = get(name)
        rev += 1
        adoptedKeys.delete(store)
        return { store: name, committed: snapshots.delete(store) }
      },
    },
    'store.restore': {
      maxArgs: 0,
      // Per store, its snapshot against now (secrets redacted), so an agent can
      // tell what a restore will put back before it does.
      journalRev: () => rev,
      // Persisted stores only: others are rebuilt from scratch on reload.
      journal: (): Record<string, StoreJournal> | undefined => {
        const out: Record<string, StoreJournal> = {}
        for (const [name, store] of Object.entries(stores)) {
          if (!store.persist || !snapshots.has(store)) continue
          const before = persisted(store, snapshots.get(store))
          const now = persisted(store, store.getState())
          if (!before || !now) continue
          const entry: StoreJournal = { original: {}, after: {} }
          const skipped: string[] = []
          const only = adoptedKeys.get(store)
          for (const k of new Set([...Object.keys(before.raw), ...Object.keys(now.raw)])) {
            if (only && !only.has(k)) continue
            const a = before.raw[k]
            const b = now.raw[k]
            if (!differs(a, b)) continue
            if (before.refused.has(k) || now.refused.has(k) || !ok(a) || !ok(b) || hidden(name, k, a, b)) {
              skipped.push(k)
              continue
            }
            if (has(before.raw, k)) entry.original[k] = json(a)
            if (has(now.raw, k)) entry.after[k] = json(b)
          }
          if (skipped.length) entry.skipped = skipped
          if (skipped.length || Object.keys(entry.original).length || Object.keys(entry.after).length) out[name] = entry
        }
        return Object.keys(out).length ? out : undefined
      },
      adopt: async (raw: unknown): Promise<AdoptResult> => {
        const data = (isObject(raw) && !Array.isArray(raw) ? raw : {}) as Record<string, StoreJournal>
        const result: AdoptResult = { adopted: [], already: [], changed: [] }
        const retry: Record<string, StoreJournal> = {}
        // Waited for together, so unready stores cost one wait, not one each.
        const ready = await Promise.all(
          Object.keys(data).map((n) => (stores[n] ? hydrated(stores[n]) : false)),
        )
        const names = Object.keys(data)
        for (const [name, entry] of Object.entries(data)) {
          const store = stores[name]
          const skipped = (entry as { skipped?: unknown } | null)?.skipped
          if (
            !isObject(entry) ||
            !isObject(entry.original) ||
            !isObject(entry.after) ||
            (skipped !== undefined && !(Array.isArray(skipped) && skipped.every((k) => typeof k === 'string')))
          ) {
            (result.invalid ??= []).push(name)
            continue
          }
          if (!store || !ready[names.indexOf(name)]) {
            retry[name] = entry
            continue
          }
          for (const k of skipped ?? []) (result.notKept ??= []).push(`${name}:${k}`)
          const now = persisted(store, store.getState())
          const saved = snapshots.has(store) && !adoptedKeys.has(store) ? persisted(store, snapshots.get(store)) : undefined
          const eq = (x: Image, y: Image, k: string) => has(x, k) === has(y, k) && (!has(x, k) || same(x[k], y[k]))
          const back: string[] = []
          for (const k of new Set([...Object.keys(entry.original), ...Object.keys(entry.after)])) {
            const label = `${name}:${k}`
            if (!now || now.refused.has(k) || !ok(now.raw[k])) {
              (result.notKept ??= []).push(label)
              continue
            }
            // The new load may already have saved the agent's value as its snapshot.
            const savedFake = !!saved && ok(saved.raw[k]) && eq(saved.raw, entry.after, k)
            if (!savedFake && eq(now.raw, entry.original, k)) result.already.push(label)
            else if (savedFake || eq(now.raw, entry.after, k)) {
              back.push(k)
              result.adopted.push(label)
            } else result.changed.push(label)
          }
          if (back.length) {
            // With no snapshot yet, restore touches only these keys; anything the app writes later stays.
            if (!snapshots.has(store)) adoptedKeys.set(store, new Set())
            const next: Record<string, unknown> = { ...((snapshots.get(store) ?? store.getState()) as Image) }
            for (const k of back) {
              if (k in entry.original) next[k] = entry.original[k]
              else delete next[k]
              adoptedKeys.get(store)?.add(k)
            }
            snapshots.set(store, next)
            rev += 1
          }
        }
        if (Object.keys(retry).length) result.retry = retry
        return result
      },
      pending: ({ detail }: { detail?: boolean } = {}) => {
        const changed = Object.entries(stores).filter(([, s]) => snapshots.has(s))
        if (!changed.length) return false
        // Replies only need to know something is pending; bridge.pending asks for detail.
        if (!detail) return true
        return Object.fromEntries(
          changed.map(([name, store]) => [
            name,
            differences(
              snapshots.get(store),
              store.getState(),
              (key, value) => out(name, value, key),
              adoptedKeys.get(store),
            ),
          ]),
        )
      },
      description:
        'Undo the agent: put back each store changed with store.set or store.call, to its state at the first of those (store.commit drops a snapshot). Returns their names.',
      run: () =>
        Object.entries(stores).flatMap(([name, store]) => {
          if (!snapshots.has(store)) return []
          rev += 1
          restore(store, snapshots.get(store), adoptedKeys.get(store))
          snapshots.delete(store)
          adoptedKeys.delete(store)
          return [name]
        }),
    },
  }
}
