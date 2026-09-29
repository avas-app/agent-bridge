// A tiny channel between the network layer and the query adapter, so neither
// imports the other: the network says when an agent mock answered a request and
// when agent mocks were removed; the query adapter listens if it is loaded.
// On globalThis, like the network state, so separate copies of the modules meet.
export type MockSignalListener = {
  /** A request started (synchronously inside the call that made it). */
  started?: (requestId: number) => void
  /** An agent mock answered a request. */
  answered?: (mockId: string, requestId: number) => void
  /** Agent mocks were removed: these ids, or every one when `ids` is undefined. */
  removed?: (ids?: string[]) => void
}

const KEY = Symbol.for('@avasapp/agent-bridge/mock-signal')

const listeners = (): Set<MockSignalListener> => {
  const g = globalThis as unknown as Record<symbol, Set<MockSignalListener> | undefined>
  return (g[KEY] ??= new Set())
}

/** Listens until the returned function is called. */
export function onMockSignal(listener: MockSignalListener): () => void {
  const all = listeners()
  all.add(listener)
  return () => {
    all.delete(listener)
  }
}

export const signalRequestStarted = (requestId: number): void => {
  for (const l of [...listeners()]) l.started?.(requestId)
}

export const signalMockAnswered = (mockId: string, requestId: number): void => {
  for (const l of [...listeners()]) l.answered?.(mockId, requestId)
}

/** How many listeners are attached. For tests. */
export const mockSignalListeners = (): number => listeners().size

export const signalMocksRemoved = (ids?: string[]): void => {
  for (const l of [...listeners()]) l.removed?.(ids)
}
