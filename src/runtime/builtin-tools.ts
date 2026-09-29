import type { LogCapture } from './logs'
import { DevSettings } from 'react-native'

import { appTools } from './tools/app'
import { bridgeTools } from './tools/bridge'
import { captureTools, loadViewShot } from './tools/capture'
import { logTools } from './tools/logs'
import { restoreTools } from './tools/restore'
import { scenarioTools } from './tools/scenario'
import { screenTools } from './tools/screen'
import type { Scenarios, Tools } from './types'

// Each area of built-in tools lives in its own file under ./tools.
// `getTools` returns every tool the app exposes, built-ins included.
export function builtinTools(
  listTools: () => unknown,
  getTools: () => Tools,
  logs: LogCapture,
  getScenarios?: () => Scenarios,
): Tools {
  return {
    ...bridgeTools(listTools),
    ...appTools(() => DevSettings.reload()),
    ...logTools(logs),
    ...restoreTools(getTools),
    ...screenTools(),
    ...captureTools(loadViewShot),
    // Only when the app defines scenarios, so `tools` doesn't list empty ones.
    ...(getScenarios && scenarioTools(getScenarios, getTools)),
  }
}
