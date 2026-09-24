import type { Found, ScreenElement } from './elements'
import { onCommit } from './settle'
import {
  indexOf,
  matchTarget,
  onScreenSummary,
  showTarget,
  type Target,
} from './targets'

export type WaitForOptions = { gone?: boolean; timeoutMs?: number }
export type WaitForResult = { ms: number; element?: ScreenElement }

const POLL_MS = 50

/**
 * Resolves when the target is on screen (or, with `gone`, when it isn't).
 * Checks after every React commit and every 50 ms; throws after `timeoutMs`
 * (default 5000, under the client's 10 s call timeout).
 */
export function waitForTarget(
  collect: () => Found[],
  target: Target,
  options: WaitForOptions = {},
): Promise<WaitForResult> {
  const timeoutMs = options.timeoutMs ?? 5000
  const t0 = performance.now()
  const ms = () => Math.round((performance.now() - t0) * 100) / 100
  return new Promise((resolve, reject) => {
    let queued = false
    let finished = false
    const finish = () => {
      finished = true
      unsubscribe()
      clearInterval(timer)
    }
    const check = () => {
      queued = false
      if (finished) return
      try {
        const found = collect()
        const matches = matchTarget(
          found.filter((f) => f.onScreen),
          target,
        )
        const hit = matches[indexOf(target) ?? 0]
        if (options.gone ? !hit : hit) {
          finish()
          resolve(hit ? { ms: ms(), element: hit.element } : { ms: ms() })
        } else if (performance.now() - t0 >= timeoutMs) {
          finish()
          const what = options.gone ? 'to disappear' : 'to appear'
          reject(
            new Error(
              `Timed out after ${timeoutMs} ms waiting for ${showTarget(target)} ${what}. On screen: ${onScreenSummary(found)}`,
            ),
          )
        }
      } catch (error) {
        finish()
        reject(error)
      }
    }
    // Check after the commit finishes, not inside React's commit phase.
    const unsubscribe = onCommit(() => {
      if (queued) return
      queued = true
      void Promise.resolve().then(check)
    })
    const timer = setInterval(check, POLL_MS)
    check()
  })
}
