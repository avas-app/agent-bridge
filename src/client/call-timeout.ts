/** Tools that wait inside the app, with the extra time the app needs past `timeoutMs` to send its own error. */
const WAITERS: Record<string, number> = {
  'screen.waitFor': 2000,
  // The page helper adds 5 s to timeoutMs before it gives up.
  'webview.waitFor': 7000,
}

/** Longest stretch: below the 2^31-1 ms a timer can hold. */
const MAX_MS = 10 * 60_000

/**
 * The call timeout to use: `base`, or longer for a wait tool whose options
 * (second argument) carry a `timeoutMs`, so the app's useful error beats ours.
 */
export function callTimeout(
  base: number,
  tool: string,
  args: readonly unknown[],
): number {
  const margin = WAITERS[tool]
  const t = (args[1] as { timeoutMs?: unknown } | null | undefined)?.timeoutMs
  if (margin === undefined || typeof t !== 'number' || !(t > 0) || !Number.isFinite(t))
    return base
  return Math.max(base, Math.min(t + margin, MAX_MS))
}
