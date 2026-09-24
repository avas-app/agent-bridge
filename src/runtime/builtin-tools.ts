import type { LogCapture } from './logs'
import { bridgeTools } from './tools/bridge'
import { logTools } from './tools/logs'
import { restoreTools } from './tools/restore'
import { screenTools } from './tools/screen'
import type { Tools } from './types'

// Each area of built-in tools lives in its own file under ./tools.
// `getTools` returns every tool the app exposes, built-ins included.
export function builtinTools(
  listTools: () => unknown,
  getTools: () => Tools,
  logs: LogCapture,
): Tools {
  return {
    ...bridgeTools(listTools),
    ...logTools(logs),
    ...restoreTools(getTools),
    ...screenTools(),
  }
}
