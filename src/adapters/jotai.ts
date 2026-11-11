import type { Tools } from '../runtime/types'
import { type NamedRedact, preview, readState, redactNamed } from './store-common'

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

// Values from before the agent's first set, per store, so tools rebuilt on
// every render still find them. Keyed by atom, since names can change.
const snapshots = new WeakMap<JotaiStoreLike, Map<JotaiAtomLike, unknown>>()

const isWritable = (atom: JotaiAtomLike) => typeof (atom as { write?: unknown }).write === 'function'

/** Read and set named Jotai atoms. */
export function jotaiTools(
  store: JotaiStoreLike,
  atoms: Record<string, JotaiAtomLike>,
  options: JotaiToolsOptions = {},
): Tools {
  let saved = snapshots.get(store)
  if (!saved) snapshots.set(store, (saved = new Map()))
  const originals = saved
  const find = (name: string) => {
    const atom = atoms[name]
    if (!atom) throw new Error(`Unknown atom "${name}". Known: ${Object.keys(atoms).join(', ')}`)
    return atom
  }
  const nameOf = (atom: JotaiAtomLike) =>
    Object.entries(atoms).find(([, a]) => a === atom)?.[0] ?? '(unnamed atom)'
  const show = (name: string, value: unknown) => redactNamed(options.redact, name, value)

  return {
    'jotai.list': {
      description: 'Atom names, each "read-write" or "read-only" (derived atoms with no write cannot be set).',
      maxArgs: 0,
      run: () =>
        Object.fromEntries(
          Object.entries(atoms).map(([name, a]) => [name, isWritable(a) ? 'read-write' : 'read-only']),
        ),
    },
    'jotai.get': {
      description:
        'Value of an atom, or a path inside it: ("user"), ("user", "address.city"), ("user", "address", "city") or ("user", ["address", "city"]). Async atoms are awaited. A last { pick: ["a.b", "c"] } returns just those fields; { keys: true } lists keys and their types without values. Atoms and paths configured with redact print as "[redacted]".',
      run: async (name: string, ...rest: unknown[]) =>
        readState(show(name, await store.get(find(name))), rest),
    },
    'jotai.set': {
      maxArgs: 2,
      description:
        'Set a writable atom to a value: ("count", 5). Returns the atom\'s new value. An atom is snapshotted on its first jotai.set since the last restore (or jotai.commit); bridge.restore sets it back to that value. Changes made before that, e.g. by tapping the UI, are not in it: set an atom to its current value first to snapshot early, and see bridge.pending. Read-only atoms are refused. A writable derived atom is set through its own write, and restored the same way.',
      run: async (name: string, value: unknown) => {
        const atom = find(name)
        if (!isWritable(atom))
          throw new Error(`Atom "${name}" is read-only: it has no write, so it cannot be set`)
        const first = !originals.has(atom)
        if (first) originals.set(atom, store.get(atom))
        try {
          await store.set(atom, value)
        } catch (e) {
          if (first) originals.delete(atom)
          throw e
        }
        return show(name, await store.get(atom))
      },
    },
    'jotai.commit': {
      maxArgs: 1,
      description:
        'Keep an atom as it is now: drops its pending snapshot, so bridge.restore leaves it alone and the next jotai.set snapshots again from this value. Returns { atom, committed } (committed: false when nothing was pending).',
      run: (name: string) => ({ atom: name, committed: originals.delete(find(name)) }),
    },
    'jotai.restore': {
      maxArgs: 0,
      pending: ({ detail }: { detail?: boolean } = {}) => {
        if (!originals.size) return false
        if (!detail) return true
        const out: Record<string, { snapshot: unknown; current: unknown }> = {}
        for (const [atom, original] of originals) {
          const current = store.get(atom)
          if (Object.is(original, current)) continue
          const name = nameOf(atom)
          out[name] = {
            snapshot: preview(show(name, original)),
            current: preview(show(name, current)),
          }
        }
        return out
      },
      description:
        'Undo the agent: set each atom changed with jotai.set back to its value at the first set (jotai.commit drops a snapshot), newest first. Returns their names. If an atom cannot be set back, the rest are still restored and the error names it; its snapshot stays.',
      run: async () => {
        const done: string[] = []
        const failed: string[] = []
        for (const [atom, original] of [...originals].reverse()) {
          const name = nameOf(atom)
          try {
            await store.set(atom, original)
            originals.delete(atom)
            done.push(name)
          } catch (e) {
            failed.push(`${name} (${e instanceof Error ? e.message : String(e)})`)
          }
        }
        if (failed.length)
          throw new Error(
            `Could not restore ${failed.join(', ')}. Restored: ${done.join(', ') || 'none'}. The snapshots of the failed atoms are kept.`,
          )
        return done
      },
    },
  }
}
