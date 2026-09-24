import { bridgeTools } from './tools/bridge'
import { screenTools } from './tools/screen'
import type { Tools } from './types'

// Each area of built-in tools lives in its own file under ./tools.
export function builtinTools(listTools: () => unknown): Tools {
  return {
    ...bridgeTools(listTools),
    ...screenTools(),
  }
}
