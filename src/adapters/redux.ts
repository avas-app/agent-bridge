import type { Tools } from '../runtime/types'
import {
  type NamedRedact,
  differences,
  isObject,
  preview,
  readState,
  redactNamed,
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

/**
 * Wrap the root reducer so the bridge can replace the state (redux.set and
 * restore): `bridgeReducer(rootReducer)`, outside redux-persist's persistReducer.
 * Release builds get the noop stub, which returns the reducer unchanged.
 */
// oxlint-disable-next-line no-explicit-any -- any reducer, as Redux's own types allow
export function bridgeReducer<R extends (state: any, action: any) => any>(reducer: R): R {
  return ((state: unknown, action: { type: string; payload?: unknown }) =>
    action.type === REPLACE ? action.payload : reducer(state, action)) as R
}

// State from before the agent's first change, per store, so tools rebuilt on
// every render still find it.
const snapshots = new WeakMap<ReduxStoreLike, { state: unknown }>()

const NOT_WRAPPED =
  'The state did not change: wrap the root reducer with bridgeReducer() from @avasapp/agent-bridge/redux (outside redux-persist\'s persistReducer), so the bridge can set slices and restore.'

/** Read, set, dispatch to and restore a Redux store. */
export function reduxTools(
  store: ReduxStoreLike,
  options: ReduxToolsOptions = {},
): Tools {
  const state = () => store.getState()
  const slices = () => (isObject(state()) ? Object.keys(state() as object) : [])
  // Redact each slice by its name; anything that isn't a slice map is one value named "state".
  const redacted = (value: unknown): unknown =>
    isObject(value)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactNamed(options.redact, k, v)]))
      : redactNamed(options.redact, 'state', value)

  const replaceWith = (next: unknown) => {
    store.dispatch({ type: REPLACE, payload: next })
    if (!Object.is(state(), next)) throw new Error(NOT_WRAPPED)
  }
  // Runs a change, snapshotting first; a change that fails leaves no snapshot behind.
  const change = <T>(fn: () => T): T => {
    const first = !snapshots.has(store)
    if (first) snapshots.set(store, { state: state() })
    const before = state()
    try {
      const result = fn()
      return result
    } catch (e) {
      if (first && Object.is(state(), before)) snapshots.delete(store)
      throw e
    }
  }
  const slice = (name: string) => {
    const s = state()
    if (!isObject(s) || !(name in s))
      throw new Error(`Unknown slice "${name}". Known: ${slices().join(', ')}`)
    return s
  }
  const changedSlices = (before: unknown, after: unknown) => {
    if (!isObject(before) || !isObject(after)) return Object.is(before, after) ? [] : ['state']
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (k) => !Object.is(before[k], after[k]),
    )
  }

  return {
    'redux.list': { description: 'Slice names (the keys of the root state).', maxArgs: 0, run: () => slices() },
    'redux.get': {
      description:
        'The whole state, or a path inside it, starting at a slice: (), ("auth"), ("auth.user.name"), ("auth", "user", "name") or ("auth", ["user", "name"]). A last { pick: ["a.b", "c"] } returns just those fields; { keys: true } lists keys and their types without values. Slices and paths configured with redact print as "[redacted]".',
      run: (...rest: unknown[]) => readState(redacted(state()), rest),
    },
    'redux.dispatch': {
      maxArgs: 1,
      description:
        'Dispatch a plain action, e.g. { type: "cart/add", payload: "apple" }. Returns { changed: [slices] }. Snapshots the state first, like redux.set: the first redux.set or redux.dispatch since the last restore is the state bridge.restore returns to. Thunks and functions cannot be sent.',
      run: (action: unknown) => {
        if (!isObject(action) || typeof action.type !== 'string')
          throw new Error('redux.dispatch takes an action as { type, payload }')
        if (action.type.startsWith('@@agent-bridge/'))
          throw new Error(`Action types starting with "@@agent-bridge/" are reserved`)
        return change(() => {
          const before = state()
          store.dispatch(action as { type: string })
          return { changed: changedSlices(before, state()) }
        })
      },
    },
    'redux.set': {
      maxArgs: 2,
      description:
        'Shallow-merge a partial into a slice: ("auth", { token: "abc" }). Skips the app\'s reducers, so no other state moves. Returns only the keys you set, with their new values. Snapshots the state first, like redux.dispatch; bridge.restore puts that snapshot back. Changes made before that, e.g. by tapping the UI, are not in it: run redux.set <slice> {} first to snapshot early, and see bridge.pending. Needs bridgeReducer() around the root reducer.',
      run: (name: string, partial: Record<string, unknown>) => {
        const s = slice(name)
        const current = s[name]
        if (!isObject(current)) throw new Error(`Slice "${name}" is not an object, so there is nothing to merge into`)
        if (!isObject(partial)) throw new Error('redux.set takes a slice name and an object')
        change(() => replaceWith({ ...s, [name]: { ...current, ...partial } }))
        const now = (state() as Record<string, Record<string, unknown>>)[name]!
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
        'Keep the state as it is now: drops the pending snapshot, so bridge.restore leaves it alone and the next redux.set or redux.dispatch snapshots again from here. Returns { committed } (false when nothing was pending).',
      run: () => ({ committed: snapshots.delete(store) }),
    },
    'redux.restore': {
      maxArgs: 0,
      pending: ({ detail }: { detail?: boolean } = {}) => {
        const snap = snapshots.get(store)
        if (!snap) return false
        if (!detail) return true
        const before = snap.state
        const now = state()
        if (!isObject(before) || !isObject(now))
          return { state: { '(value)': { snapshot: preview(before), current: preview(now) } } }
        const out: Record<string, unknown> = {}
        for (const k of changedSlices(before, now)) {
          const a = redactNamed(options.redact, k, before[k])
          const b = redactNamed(options.redact, k, now[k])
          out[k] =
            isObject(before[k]) && isObject(now[k])
              ? differences(
                  before[k],
                  now[k],
                  (key, v) => (redactNamed(options.redact, k, { [key]: v }) as Record<string, unknown>)[key],
                )
              : { '(value)': { snapshot: preview(a), current: preview(b) } }
        }
        return out
      },
      description:
        'Undo the agent: put the whole state back to what it was at the first redux.set or redux.dispatch (redux.commit drops the snapshot). Returns ["redux"], or [] when nothing was pending. With redux-persist, the persisted copy follows the state.',
      run: () => {
        const snap = snapshots.get(store)
        if (!snap) return []
        replaceWith(snap.state)
        snapshots.delete(store)
        return ['redux']
      },
    },
  }
}
