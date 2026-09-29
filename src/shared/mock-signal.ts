// A tiny channel between the network layer and the query adapter, so neither
// imports the other: the network says when an agent mock answered a request and
// when agent mocks were removed; the query adapter listens if it is loaded.
// On globalThis, like the network state, so separate copies of the modules meet.
export type MockSignalListener = {
  /** An agent mock answered a request. */
  answered?: (mockId: string) => void
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

export const signalMockAnswered = (mockId: string): void => {
  for (const l of [...listeners()]) l.answered?.(mockId)
}

export const signalMocksRemoved = (ids?: string[]): void => {
  for (const l of [...listeners()]) l.removed?.(ids)
}
