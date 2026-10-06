import type { Found, ScreenElement } from './elements'
import { nearMisses } from './find-text'
import { onCommit } from './settle'
import {
  indexOf,
  matchTarget,
  onScreenSummary,
  showTarget,
  type Target,
} from './targets'

export type WaitForOptions = { gone?: boolean; timeoutMs?: number; scroll?: boolean }
export type WaitForResult = { ms: number; element?: ScreenElement }

const POLL_MS = 50

function nearMissNote(found: Found[], target: Target): string {
  const text = typeof target === 'string' ? target : target.text
  const near = text ? nearMisses(found, text) : []
  if (!near.length) return ''
  const offscreen = matchTarget(
    found.filter((f) => !f.onScreen && !f.hidden),
    target,
  ).length
  const hint = offscreen ? '. {scroll:true} scrolls an off-screen match into view' : ''
  return `. Near misses: ${near.join('; ')}${hint}`
}

/**
 * Resolves when the target is on screen (or, with `gone`, when it isn't).
 * With `scroll`, a match that is rendered but off screen counts too, and is
 * passed to `reveal` to be scrolled into view. `gone` with `scroll` is refused:
 * scrolling can only move a match onto the screen, never make it go away.
 * Checks after every React commit and every 50 ms; throws after `timeoutMs`
 * (default 5000, under the client's 10 s call timeout).
 */
export function waitForTarget(
  collect: () => Found[],
  target: Target,
  options: WaitForOptions = {},
  reveal?: (found: Found) => Promise<Found>,
): Promise<WaitForResult> {
  if (options.gone && options.scroll)
    return Promise.reject(
      new Error("{gone:true} and {scroll:true} can't be combined: gone waits for the target to leave the screen"),
    )
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
        const reachable = found.filter((f) => !f.hidden)
        let matches = matchTarget(
          reachable.filter((f) => f.onScreen),
          target,
        )
        if (!matches.length && options.scroll && reveal) matches = matchTarget(reachable, target)
        const hit = matches[indexOf(target) ?? 0]
        if (hit && !hit.onScreen && reveal) {
          finish()
          reveal(hit).then((f) => resolve({ ms: ms(), element: f.element }), reject)
        } else if (options.gone ? !hit : hit) {
          finish()
          resolve(hit ? { ms: ms(), element: hit.element } : { ms: ms() })
        } else if (performance.now() - t0 >= timeoutMs) {
          finish()
          const what = options.gone ? 'to disappear' : 'to appear'
          reject(
            new Error(
              `Timed out after ${timeoutMs} ms waiting for ${showTarget(target)} ${what}. On screen: ${onScreenSummary(found)}${nearMissNote(found, target)}`,
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
