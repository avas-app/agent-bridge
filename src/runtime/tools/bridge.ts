import type { Tools } from '../types'

export function bridgeTools(listTools: () => unknown, deviceId?: string): Tools {
  return {
    'bridge.ping': {
      description:
        'Round-trip check. Returns the app clock and the id this bridge install has; a new id means the app reloaded.',
      run: () => ({ pong: true, at: Date.now(), deviceId }),
    },
    'bridge.tools': {
      description: 'Every tool this app exposes.',
      run: listTools,
    },
  }
}
