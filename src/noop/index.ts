// Production build of the runtime entry. Imports nothing, so release bundles
// carry none of the bridge.
const inert = () => ({ name: 'noop', start: () => () => {} })

export const startAgentBridge = (): (() => void) => () => {}
export const useAgentBridge = (): void => {}
export const cdpTransport = inert
