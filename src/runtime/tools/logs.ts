import type { LogCapture } from '../logs'
import type { Tools } from '../types'
import { TOOL_DESCRIPTIONS } from './descriptions'

type Options = { level?: 'error' | 'warn' | 'all'; clear?: boolean; limit?: number }

export function logTools(logs: LogCapture): Tools {
  return {
    'bridge.logs': {
      description: TOOL_DESCRIPTIONS['bridge.logs'],
      run: (options: Options = {}) => {
        const entries = logs.read(options)
        if (options.clear) logs.clear()
        return entries
      },
    },
  }
}
