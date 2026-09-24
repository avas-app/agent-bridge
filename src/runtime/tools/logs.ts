import type { LogCapture } from '../logs'
import type { Tools } from '../types'

type Options = { level?: 'error' | 'warn' | 'all'; clear?: boolean; limit?: number }

export function logTools(logs: LogCapture): Tools {
  return {
    'bridge.logs': {
      description:
        'Errors and warnings the app logged, newest last. Options: {level: "error"|"warn"|"all", limit, clear}.',
      run: (options: Options = {}) => {
        const entries = logs.read(options)
        if (options.clear) logs.clear()
        return entries
      },
    },
  }
}
