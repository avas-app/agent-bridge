import type { LogCapture } from './logs'
import { bridgeTools } from './tools/bridge'
import { logTools } from './tools/logs'
import { screenTools } from './tools/screen'
import type { Tools } from './types'

// Each area of built-in tools lives in its own file under ./tools.
export function builtinTools(
  listTools: () => unknown,
  logs: LogCapture,
): Tools {
  return {
    ...bridgeTools(listTools),
    ...logTools(logs),
    ...screenTools(),
  }
}
