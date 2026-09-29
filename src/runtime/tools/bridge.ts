import type { Tools } from '../types'

export function bridgeTools(listTools: () => unknown): Tools {
  return {
    'bridge.ping': {
      description: 'Round-trip check. Returns the app clock.',
      run: () => ({ pong: true, at: Date.now() }),
    },
    'bridge.tools': {
      description: 'Every tool this app exposes.',
      run: listTools,
    },
  }
}
