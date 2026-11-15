import type { Tools } from '../types'
import { TOOL_DESCRIPTIONS } from './descriptions'

export function bridgeTools(listTools: () => unknown): Tools {
  return {
    'bridge.ping': {
      description: TOOL_DESCRIPTIONS['bridge.ping'],
      run: () => ({ pong: true, at: Date.now() }),
    },
    'bridge.tools': {
      description: TOOL_DESCRIPTIONS['bridge.tools'],
      run: listTools,
    },
  }
}
