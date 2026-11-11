import type { Tools } from '../runtime/types'
import {
  type NamedRedact,
  differences,
  isObject,
  preview,
  readState,
  redactNamed,
  warnUnknownRedact,
} from './store-common'

/** Anything with a Redux store's shape, including Redux Toolkit's configureStore. */
export type ReduxStoreLike = {
  getState: () => unknown
  // Method syntax, so Redux's generic dispatch types still fit.
  dispatch(action: { type: string; payload?: unknown }): unknown
}

export type { NamedRedact as ReduxRedact }
export type ReduxToolsOptions = {
  /** By slice name, as `{ auth: ['token'] }` or `{ session: true }`, or a hook `(slice, path, value)`. */
  redact?: NamedRedact
}

const REPLACE = '@@agent-bridge/replace'

// The next state travels here, not in the action, so middleware and devtools never see it.
let stash: { state: unknown } | undefined
// Bumped each time a bridgeReducer handles the replace; replaceWith checks it moved.
let handled = 0

/**
 * Wrap the root reducer so the bridge can replace the state (redux.set and
 * restore): `bridgeReducer(rootReducer)`. With redux-persist, wrap the reducer
 * inside persistReducer: `persistReducer(config, bridgeReducer(rootReducer))`,
 * so the saved copy follows. Release builds get the noop stub, which returns
 * the reducer unchanged.
 */
// oxlint-disable-next-line no-explicit-any -- any reducer, as Redux's own types allow
export function bridgeReducer<R extends (state: any, action: any) => any>(reducer: R): R {
  return ((state: unknown, action: { type: string }) => {
    if (action.type !== REPLACE || !stash) return reducer(state, action)
    handled += 1
    return stash.state
  }) as R
}

type Entry = { original: unknown; after: unknown }
// Per store, so tools rebuilt on every render still find it: each slice redux.set
// changed, and the whole state from before the first redux.dispatch.
type Snapshot = { slices: Map<string, Entry>; whole?: { state: unknown } }
const snapshots = new WeakMap<ReduxStoreLike, Snapshot>()

const NOT_WRAPPED =
  'The bridge could not replace the state: wrap the root reducer with bridgeReducer() from @avasapp/agent-bridge/redux (inside redux-persist\'s persistReducer, and again after store.replaceReducer), so the bridge can set slices and restore.'

const isRecord = (v: unknown): v is Record<string, unknown> => isObject(v) && !Array.isArray(v)
// redux-persist's bookkeeping key: never snapshotted or put back.
const PERSIST = '_persist'
const withoutPersist = (v: unknown) => {
  if (!isRecord(v) || !(PERSIST in v)) return v
  const { [PERSIST]: _, ...rest } = v
  return rest
}

/** Read, set, dispatch to and restore a Redux store. */
export function reduxTools(
  store: ReduxStoreLike,
  options: ReduxToolsOptions = {},
): Tools {
  const state = () => store.getState()
  const slices = () => (isRecord(state()) ? Object.keys(state() as object).filter((k) => k !== PERSIST) : [])
  warnUnknownRedact(options.redact, [...slices(), 'state'], 'redux')
  // Redact each slice by its name; anything that isn't a slice map is one value named "state".
  const redacted = (value: unknown): unknown =>
    isRecord(value)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactNamed(options.redact, k, v)]))
      : redactNamed(options.redact, 'state', value)

  const replaceWith = (next: unknown) => {
    const before = handled
    stash = { state: next }
    try {
      store.dispatch({ type: REPLACE })
    } finally {
      stash = undefined
    }
    if (handled === before) throw new Error(NOT_WRAPPED)
  }
  // Wraps a change; the first one of each kind records what to put back, and a failed one leaves nothing behind.
  const snapshot = () => {
    let snap = snapshots.get(store)
    if (!snap) snapshots.set(store, (snap = { slices: new Map() }))
    return snap
  }
  const empty = (snap: Snapshot) => {
    if (!snap.slices.size && !snap.whole) snapshots.delete(store)
  }
  const slice = (name: string) => {
    const s = state()
    if (!isRecord(s) || !(name in s) || name === PERSIST)
      throw new Error(`Unknown slice "${name}". Known: ${slices().join(', ')}`)
    return s
  }
  const changedSlices = (before: unknown, after: unknown) => {
    if (!isRecord(before) || !isRecord(after)) return Object.is(before, after) ? [] : ['state']
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (k) => k !== PERSIST && !Object.is(before[k], after[k]),
    )
  }
  // What restore would change in one slice (or the whole non-object state), redacted.
  const diffOf = (k: string, before: unknown, now: unknown) =>
    isRecord(before) && isRecord(now)
      ? differences(
          before,
          now,
          (key, v) => (redactNamed(options.redact, k, { [key]: v }) as Record<string, unknown>)[key],
        )
      : { '(value)': { snapshot: preview(redactNamed(options.redact, k, before)), current: preview(redactNamed(options.redact, k, now)) } }

  return {
    'redux.list': { description: 'Slice names (the keys of the root state).', maxArgs: 0, run: () => slices() },
    'redux.get': {
      description:
        'The whole state, or a path inside it, starting at a slice: (), ("auth"), ("auth.user.name"), ("auth", "user", "name") or ("auth", ["user", "name"]). A last { pick: ["a.b", "c"] } returns just those fields; { keys: true } lists keys and their types without values. Slices and paths configured with redact print as "[redacted]".',
      run: (...rest: unknown[]) => readState(redacted(state()), rest, 'redux.get'),
    },
    'redux.dispatch': {
      maxArgs: 1,
      description:
        'Dispatch a plain action, e.g. { type: "cart/add", payload: "apple" }. Returns { changed: [slices] }. The first redux.dispatch since the last restore snapshots the WHOLE state, so bridge.restore puts all of it back, including what the app changed in other slices after that (redux.set is per slice: prefer it for a state you want to set). redux-persist\'s _persist is never put back. Thunks and functions cannot be sent.',
      run: (action: unknown) => {
        if (!isObject(action) || typeof action.type !== 'string')
          throw new Error('redux.dispatch takes an action as { type, payload }')
        if (action.type.startsWith('@@agent-bridge/'))
          throw new Error(`Action types starting with "@@agent-bridge/" are reserved`)
        const snap = snapshot()
        const before = state()
        const first = !snap.whole
        if (first) snap.whole = { state: withoutPersist(before) }
        try {
          store.dispatch(action as { type: string })
        } catch (e) {
          if (first && Object.is(state(), before)) delete snap.whole
          empty(snap)
          throw e
        }
        const changed = changedSlices(before, state())
        for (const k of changed) {
          const entry = snap.slices.get(k)
          if (entry) entry.after = (state() as Record<string, unknown>)[k]
        }
        empty(snap)
        return { changed }
      },
    },
    'redux.set': {
      maxArgs: 2,
      description:
        'Shallow-merge a partial into an object slice: ("auth", { token: "abc" }). Skips the app\'s reducers, so no other state moves. Array slices are refused. Returns only the keys you set, with their new values. Each slice is snapshotted on its first redux.set since the last restore (redux.commit drops them); bridge.restore puts that slice back, and leaves alone any slice the app changed after you (returned in {skipped}). Changes made before the first set, e.g. by tapping the UI, are not in the snapshot: run redux.set <slice> {} first to snapshot early, and see bridge.pending. Needs bridgeReducer() around the root reducer.',
      run: (name: string, partial: Record<string, unknown>) => {
        const s = slice(name)
        const current = s[name]
        if (Array.isArray(current))
          throw new Error(`Slice "${name}" is an array, so redux.set cannot merge into it. Use redux.dispatch with one of the app's actions`)
        if (!isRecord(current)) throw new Error(`Slice "${name}" is not an object, so there is nothing to merge into`)
        if (!isRecord(partial)) throw new Error('redux.set takes a slice name and an object (not an array)')
        const snap = snapshot()
        const track = !snap.whole && !snap.slices.has(name)
        if (track) snap.slices.set(name, { original: current, after: current })
        try {
          replaceWith({ ...s, [name]: { ...current, ...partial } })
        } catch (e) {
          if (track) snap.slices.delete(name)
          empty(snap)
          throw e
        }
        const now = (state() as Record<string, Record<string, unknown>>)[name]!
        const entry = snap.slices.get(name)
        if (entry) entry.after = now
        return redactNamed(
          options.redact,
          name,
          Object.fromEntries(Object.keys(partial).map((k) => [k, now[k]])),
        )
      },
    },
    'redux.commit': {
      maxArgs: 0,
      description:
        'Keep the state as it is now: drops the pending snapshots, so bridge.restore leaves it alone and the next redux.set or redux.dispatch snapshots again from here. Returns { committed } (false when nothing was pending).',
      run: () => ({ committed: snapshots.delete(store) }),
    },
    'redux.restore': {
      maxArgs: 0,
      pending: ({ detail }: { detail?: boolean } = {}) => {
        const snap = snapshots.get(store)
        if (!snap) return false
        if (!detail) return true
        const now = state()
        const out: Record<string, unknown> = {}
        if (snap.whole) {
          const before = snap.whole.state
          for (const k of changedSlices(before, now))
            out[k] = diffOf(k, isRecord(before) ? before[k] : before, isRecord(now) ? now[k] : now)
        }
        for (const [k, e] of snap.slices)
          if (isRecord(now) && !Object.is(e.original, now[k])) out[k] = diffOf(k, e.original, now[k])
        return out
      },
      description:
        'Undo the agent: put back each slice changed with redux.set, and, if redux.dispatch was used, the whole state from before its first call (redux.commit drops the snapshots). Returns ["redux"], or [] when nothing was pending. A slice the app changed after the agent set it is left alone and returned as { restored, skipped }. With redux-persist (bridgeReducer inside persistReducer) the saved copy follows. Lost when the JS reloads: restore before app.reload.',
      run: () => {
        const snap = snapshots.get(store)
        if (!snap) return []
        const cur = state()
        let next: unknown = cur
        if (snap.whole) {
          next = snap.whole.state
          if (isRecord(next) && isRecord(cur) && PERSIST in cur) next = { ...next, [PERSIST]: cur[PERSIST] }
        }
        const skipped: string[] = []
        let any = Boolean(snap.whole)
        for (const [k, e] of snap.slices) {
          if (!isRecord(cur) || !Object.is(cur[k], e.after)) {
            skipped.push(k)
            if (isRecord(next) && isRecord(cur) && k in cur) next = { ...next, [k]: cur[k] }
            continue
          }
          next = { ...(next as Record<string, unknown>), [k]: e.original }
          any = true
        }
        if (any) replaceWith(next)
        snapshots.delete(store)
        return skipped.length ? { restored: any ? ['redux'] : [], skipped } : ['redux']
      },
    },
  }
}
