/** One key in one storage: how to read, write and delete it. */
export type KeyIo = {
  read: () => Promise<string | null>
  write: (value: string) => Promise<void>
  remove: () => Promise<void>
}

type Entry = {
  io: KeyIo
  // The value from before the agent's first write (null: the key did not exist).
  original: Promise<string | null>
  // What the agent left in the key, to tell later app writes from its own.
  last: string | null
}

/** Pending changes of one storage, shared by every rebuild of its tools. */
export type KeyUndo = Map<string, Entry>

/** The value to store, or an error before anything is read or changed. */
export function toStored(tool: string, key: unknown, value: unknown): string {
  if (typeof key !== 'string' || !key)
    throw new Error(`${tool} needs the key name as a non-empty string`)
  if (value === undefined || value === null)
    throw new Error(`${tool} needs a value; use the delete tool to remove "${key}"`)
  const stored = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof stored !== 'string')
    throw new Error(`${tool} cannot store that value as JSON`)
  return stored
}

/** Saves the key's first original, then writes (`value`) or deletes (null). */
export async function change(
  undo: KeyUndo,
  id: string,
  io: KeyIo,
  value: string | null,
): Promise<void> {
  let entry = undo.get(id)
  if (!entry) {
    // The promise goes in first so two writes to one key can't both snapshot.
    const original = io.read()
    entry = { io, original, last: null }
    undo.set(id, entry)
    try {
      entry.last = await original
    } catch (error) {
      if (undo.get(id) === entry) undo.delete(id)
      throw error
    }
  } else {
    await entry.original
  }
  if (value === null) await io.remove()
  else await io.write(value)
  entry.last = value
}

/** Puts keys back. A key the app wrote since the agent did is left alone and listed in `skipped`. */
export async function restore(
  undo: KeyUndo,
  label: (id: string) => string,
): Promise<{ restored: number; skipped: string[]; failed: string[] }> {
  let restored = 0
  const skipped: string[] = []
  const failed: string[] = []
  for (const [id, entry] of [...undo]) {
    try {
      let original: string | null
      try {
        original = await entry.original
      } catch {
        // The read failed, so the agent's write never ran: nothing to put back.
        undo.delete(id)
        continue
      }
      if ((await entry.io.read()) !== entry.last) {
        undo.delete(id)
        skipped.push(label(id))
        continue
      }
      if (original === null) await entry.io.remove()
      else await entry.io.write(original)
      undo.delete(id)
      restored += 1
    } catch {
      failed.push(label(id))
    }
  }
  return { restored, skipped, failed }
}

export function describeRestore(
  r: { restored: number; skipped: string[]; failed: string[] },
  what: string,
): number | { restored: number; skipped: string[] } {
  if (r.failed.length)
    throw new Error(
      `Restored ${r.restored}, could not restore: ${r.failed.join(', ')}. ${what} stay pending; run it again.`,
    )
  return r.skipped.length
    ? { restored: r.restored, skipped: r.skipped }
    : r.restored
}
