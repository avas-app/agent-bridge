// Production build of the runtime entry. Imports nothing, so release bundles
// carry none of the bridge.
const inert = () => ({ name: 'noop', start: () => () => {} })

export const startAgentBridge = (): (() => void) => () => {}
export const useAgentBridge = (): void => {}
export const cdpTransport = inert
export const settle = (): Promise<{ commits: number; ms: number }> =>
  Promise.resolve({ commits: 0, ms: 0 })
