type Undo = { label?: string; fn: () => unknown }

// Module level, so a remount of the hook (Fast Refresh) still undoes what a
// tool registered before it.
const undos: Undo[] = []

/**
 * Registers an undo for something a tool of yours changed. `bridge.restore`
 * runs it once, newest first, and `bridge.pending` lists it under `app` (with
 * `label`) until then. Call it from a tool's `run`, each time it changes
 * something:
 *
 * ```ts
 * 'host.mockMethod': (name, value) => {
 *   const original = host[name]
 *   host[name] = () => value
 *   onRestore(() => { host[name] = original }, `host.${name}`)
 * }
 * ```
 */
export function onRestore(fn: () => unknown, label?: string): void {
  if (typeof fn !== 'function') throw new Error('onRestore takes a function')
  undos.push({ fn, label })
}

/** What a restore would run: the labels (unlabelled ones count as "undo"), newest first. */
export function pendingUndos(): string[] {
  return undos.map((u) => u.label ?? 'undo').reverse()
}

/** Runs and forgets every registered undo, newest first. Returns the errors. */
export async function runUndos(): Promise<{ ran: number; errors: string[] }> {
  const batch = undos.splice(0).reverse()
  const errors: string[] = []
  for (const { fn, label } of batch) {
    try {
      await fn()
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      errors.push(label ? `${label}: ${why}` : why)
    }
  }
  return { ran: batch.length, errors }
}

/** Forgets every registered undo without running it. For tests. */
export function resetUndos(): void {
  undos.length = 0
}
