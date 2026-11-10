/** Extra time past a tool's own `timeoutMs`, so the app's timeout error arrives first. */
const MARGIN_MS = 2000

/**
 * The call timeout to use: `base`, or longer when an argument carries its own
 * `timeoutMs` (screen.waitFor), so the app's useful error beats ours.
 */
export function callTimeout(base: number, args: readonly unknown[]): number {
  let wanted = base
  for (const arg of args) {
    const t = (arg as { timeoutMs?: unknown } | null)?.timeoutMs
    if (typeof arg === 'object' && typeof t === 'number' && Number.isFinite(t))
      wanted = Math.max(wanted, t + MARGIN_MS)
  }
  return wanted
}
