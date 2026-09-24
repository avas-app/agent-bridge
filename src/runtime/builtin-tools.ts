import { bridgeTools } from './tools/bridge'
import { restoreTools } from './tools/restore'
import { screenTools } from './tools/screen'
import type { Tools } from './types'

// Each area of built-in tools lives in its own file under ./tools.
// `getTools` returns every tool the app exposes, built-ins included.
export function builtinTools(
  listTools: () => unknown,
  getTools: () => Tools,
): Tools {
  return {
    ...bridgeTools(listTools),
    ...restoreTools(getTools),
    ...screenTools(),
  }
}
