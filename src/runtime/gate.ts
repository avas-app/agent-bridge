export type Gate = {
  name: string
  /** True while anything holds the gate closed. */
  readonly closed: boolean
  /**
   * Closes the gate until the returned function is called. Closes are
   * counted, so the gate opens when the last one is released. Hand the
   * result to a scenario's `onUndo`.
   */
  close: () => () => void
  /** Calls `fn(closed)` when the gate closes or opens. Returns an unsubscribe. */
  subscribe: (fn: (closed: boolean) => void) => () => void
}

/**
 * A switch app code checks before a side effect a scenario must hold off,
 * e.g. connecting a realtime client with a fake token. Always open in a
 * release build.
 */
export function createGate(name: string): Gate {
  let holds = 0
  const listeners = new Set<(closed: boolean) => void>()
  const notify = () => {
    for (const fn of [...listeners]) fn(holds > 0)
  }
  return {
    name,
    get closed() {
      return holds > 0
    },
    close: () => {
      let released = false
      holds += 1
      if (holds === 1) notify()
      return () => {
        if (released) return
        released = true
        holds -= 1
        if (holds === 0) notify()
      }
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}
