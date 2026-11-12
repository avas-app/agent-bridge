import type { Tools } from '../runtime/types'
import { type NamedRedact, preview, readState, redactNamed, warnUnknownRedact } from './store-common'

/** Anything with a Jotai store's shape: getDefaultStore(), createStore(), or the Provider's store. */
export type JotaiStoreLike = {
  // Method syntax and `any`, so Jotai's generic overloads still fit.
  // oxlint-disable-next-line no-explicit-any
  get(atom: any): unknown
  // oxlint-disable-next-line no-explicit-any
  set(atom: any, ...args: any[]): unknown
}

/** A Jotai atom; the adapter only checks whether it has a `write`. */
export type JotaiAtomLike = object

export type { NamedRedact as JotaiRedact }
export type JotaiToolsOptions = {
  /** By atom name, as `{ token: true }` or `{ user: ['phone'] }`, or a hook `(atom, path, value)`. */
  redact?: NamedRedact
}

type Entry = { original: unknown; after: unknown }
// Per store, keyed by atom name (Fast Refresh makes new atom objects), so tools
// rebuilt on every render still find what the agent changed.
const snapshots = new WeakMap<JotaiStoreLike, Map<string, Entry>>()

const isWritable = (atom: JotaiAtomLike) => typeof (atom as { write?: unknown }).write === 'function'

const same = (a: unknown, b: unknown) => {
  if (Object.is(a, b)) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** Read, set and restore named Jotai atoms. */
export function jotaiTools(
  store: JotaiStoreLike,
  atoms: Record<string, JotaiAtomLike>,
  options: JotaiToolsOptions = {},
): Tools {
  let saved = snapshots.get(store)
  if (!saved) snapshots.set(store, (saved = new Map()))
  const entries = saved
  warnUnknownRedact(options.redact, Object.keys(atoms), 'jotai')
  const find = (name: string) => {
    const atom = atoms[name]
    if (!atom) throw new Error(`Unknown atom "${name}". Known: ${Object.keys(atoms).join(', ')}`)
    return atom
  }
  const show = (name: string, value: unknown) => redactNamed(options.redact, name, value)
  // Reading an atom nobody mounted gives its initial value, even for atomWithStorage; mounting runs its onMount read first.
  const read = async (atom: JotaiAtomLike) => {
    const store2 = store as JotaiStoreLike & { sub?: (atom: object, cb: () => void) => () => void }
    const unsub = store2.sub?.(atom, () => {})
    try {
      return await store.get(atom)
    } finally {
      unsub?.()
    }
  }

  return {
    'jotai.list': {
      description:
        'Atom names, each "read-write" or "read-only" (derived atoms with no write cannot be set). Action atoms (write-only, like atom(null, write)) show as read-write but jotai.set refuses them.',
      maxArgs: 0,
      run: () =>
        Object.fromEntries(
          Object.entries(atoms).map(([name, a]) => [name, isWritable(a) ? 'read-write' : 'read-only']),
        ),
    },
    'jotai.get': {
      description:
        'Value of an atom, or a path inside it: ("user"), ("user", "address.city"), ("user", "address", "city") or ("user", ["address", "city"]). Async atoms are awaited. A last { pick: ["a.b", "c"] } returns just those fields; { keys: true } lists keys and their types without values. Atoms and paths configured with redact print as "[redacted]". Only atoms in the store you passed are visible: a <Provider> without a store prop has its own store.',
      run: async (name: string, ...rest: unknown[]) =>
        readState(show(name, await store.get(find(name))), rest, 'jotai.get'),
    },
    'jotai.set': {
      maxArgs: 2,
      description:
        'Set a writable atom to a value: ("count", 5). Returns the atom\'s new value. An atom is snapshotted on its first jotai.set since the last restore (or jotai.commit); bridge.restore sets it back to that value, and leaves alone an atom the app changed after you (returned in {skipped}). Changes made before that, e.g. by tapping the UI, are not in it: set an atom to its current value first to snapshot early, and see bridge.pending. Read-only atoms are refused, and so is any atom whose value is not the one you sent afterwards (an action atom or atomWithReducer: its write already ran and cannot be undone). A writable derived atom is set through its own write, and restored the same way.',
      run: async (name: string, value: unknown) => {
        const atom = find(name)
        if (!isWritable(atom))
          throw new Error(`Atom "${name}" is read-only: it has no write, so it cannot be set`)
        const first = !entries.has(name)
        if (first) {
          const original = await read(atom)
          entries.set(name, { original, after: original })
        }
        try {
          await store.set(atom, value)
        } catch (e) {
          if (first) entries.delete(name)
          throw e
        }
        const now = await store.get(atom)
        if (!same(now, value)) {
          if (first) entries.delete(name)
          throw new Error(
            `Atom "${name}" did not take the value: it reads ${JSON.stringify(preview(show(name, now)))} after the set. Its write is probably an action or a reducer, which already ran and cannot be undone, so it is not snapshotted.`,
          )
        }
        entries.get(name)!.after = now
        return show(name, now)
      },
    },
    'jotai.commit': {
      maxArgs: 1,
      description:
        'Keep an atom as it is now: drops its pending snapshot, so bridge.restore leaves it alone and the next jotai.set snapshots again from this value. Returns { atom, committed } (committed: false when nothing was pending).',
      run: (name: string) => ({ atom: name, committed: entries.delete(name) }),
    },
    'jotai.restore': {
      maxArgs: 0,
      pending: ({ detail }: { detail?: boolean } = {}) => {
        if (!entries.size) return false
        if (!detail) return true
        const out: Record<string, { snapshot: unknown; current: unknown }> = {}
        for (const [name, e] of entries) {
          const atom = atoms[name]
          const raw = atom ? store.get(atom) : undefined
          if (atom && same(e.original, raw)) continue
          out[name] = {
            snapshot: preview(show(name, e.original)),
            current: !atom
              ? '(no atom has this name now)'
              : raw instanceof Promise
                ? '(async)'
                : preview(show(name, raw)),
          }
        }
        return out
      },
      description:
        'Undo the agent: set each atom changed with jotai.set back to its value at the first set (jotai.commit drops a snapshot), newest first. Returns their names; an atom the app changed after the agent is left alone and returned as { restored, skipped }. If an atom cannot be set back (or the write does not take), the rest are still restored and the error names it; its snapshot stays.',
      run: async () => {
        const done: string[] = []
        const skipped: string[] = []
        const failed: string[] = []
        for (const [name, e] of [...entries].reverse()) {
          const atom = atoms[name]
          if (!atom) {
            failed.push(`${name} (no atom has this name now)`)
            continue
          }
          try {
            if (!same(await store.get(atom), e.after)) {
              entries.delete(name)
              skipped.push(name)
              continue
            }
            await store.set(atom, e.original)
            if (!same(await store.get(atom), e.original)) {
              failed.push(`${name} (the write did not change it back)`)
              continue
            }
            entries.delete(name)
            done.push(name)
          } catch (err) {
            failed.push(`${name} (${err instanceof Error ? err.message : String(err)})`)
          }
        }
        if (failed.length)
          throw new Error(
            `Could not restore ${failed.join(', ')}. Restored: ${done.join(', ') || 'none'}. The snapshots of the failed atoms are kept.`,
          )
        return skipped.length ? { restored: done, skipped } : done
      },
    },
  }
}
