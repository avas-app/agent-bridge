// Knows when React has committed what a tool caused. It counts commits through
// the DevTools hook (chaining whatever handler is already there) and reads each
// root's pending lanes to see whether an update is still queued.

type FiberRoot = { pendingLanes?: number; suspendedLanes?: number }

type Hook = {
  renderers?: Map<number, unknown>
  getFiberRoots?: (rendererId: number) => Set<FiberRoot>
  onCommitFiberRoot?: (...args: unknown[]) => unknown
}

type CommitState = { commits: number; listeners: Set<() => void> }

export type SettleResult = { commits: number; ms: number }

// The state lives on the installed wrapper, so a Fast Refresh of this module
// finds the same counter instead of wrapping twice.
const STATE = Symbol.for('@avasapp/agent-bridge/commits')

// Sync, input, default and transition lanes: work that renders soon. Retry,
// idle and offscreen lanes can stay pending indefinitely.
const UPDATE_LANES = (1 << 22) - 1

const hook = () =>
  (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: Hook })
    .__REACT_DEVTOOLS_GLOBAL_HOOK__

const now = () => performance.now()

function install(): CommitState | null {
  const h = hook()
  if (!h) return null
  const current = h.onCommitFiberRoot as
    | (((...args: unknown[]) => unknown) & { [STATE]?: CommitState })
    | undefined
  const existing = current?.[STATE]
  if (existing) return existing
  const state: CommitState = { commits: 0, listeners: new Set() }
  const wrapped = function (this: unknown, ...args: unknown[]) {
    state.commits += 1
    for (const listener of state.listeners) {
      try {
        listener()
      } catch {
        // A listener must never break React's commit.
      }
    }
    return current?.apply(this, args)
  }
  Object.defineProperty(wrapped, STATE, { value: state })
  h.onCommitFiberRoot = wrapped
  return state
}

/** Calls `listener` after every React commit. Returns an unsubscribe. */
export function onCommit(listener: () => void): () => void {
  const state = install()
  state?.listeners.add(listener)
  return () => state?.listeners.delete(listener)
}

/** True while any root has an update queued that React hasn't committed. */
function busy(): boolean {
  const h = hook()
  if (!h?.renderers || !h.getFiberRoots) return false
  for (const id of h.renderers.keys()) {
    for (const root of h.getFiberRoots(id)) {
      const pending = root.pendingLanes
      if (typeof pending !== 'number') continue
      if (pending & ~(root.suspendedLanes ?? 0) & UPDATE_LANES) return true
    }
  }
  return false
}

const frame = () =>
  new Promise<void>((resolve) => {
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown })
      .requestAnimationFrame
    if (raf) raf(() => resolve())
    else setTimeout(resolve, 16)
  })

/**
 * Resolves once React has committed the renders queued so far: after a tick
 * (TanStack Query notifies on a timeout), then until a frame passes with no
 * commit and nothing queued. Returns right away when nothing was queued, and
 * gives up after `maxMs` (default 500).
 */
export async function settle(
  options: { maxMs?: number } = {},
): Promise<SettleResult> {
  const maxMs = options.maxMs ?? 500
  const t0 = now()
  const state = install()
  const start = state?.commits ?? 0
  const result = (): SettleResult => ({
    commits: (state?.commits ?? 0) - start,
    ms: Math.round((now() - t0) * 100) / 100,
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  if (!state) return result()
  let seen = state.commits
  if (seen === start && !busy()) return result()
  while (now() - t0 < maxMs) {
    await frame()
    if (state.commits === seen && !busy()) break
    seen = state.commits
  }
  return result()
}
