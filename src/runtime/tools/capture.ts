import type { Tools } from '../types'
import { TOOL_DESCRIPTIONS } from './descriptions'

/** The slice of react-native-view-shot this tool uses. */
export type ViewShot = {
  captureScreen: (options: {
    format: 'png' | 'jpg'
    quality?: number
    result: 'tmpfile' | 'base64'
  }) => Promise<string>
}

// Base64 replies bigger than this fall back to a file path.
const MAX_BASE64_CHARS = 200_000
// Callers that are not an agent (the dials panel) may take more, up to this.
const MAX_BASE64_CEILING = 4_000_000

const UNAVAILABLE =
  'screen.capture needs react-native-view-shot, which this app does not have. Take the screenshot with agent-device, `xcrun simctl io booted screenshot <file>` (iOS simulator) or `adb exec-out screencap -p > <file>` (Android) instead.'

/**
 * Loads react-native-view-shot if the app already has it. The literal
 * `require` inside try/catch is what makes it optional to Metro: Metro treats
 * a require in a try block as an optional dependency and does not fail the
 * bundle when the package is missing. A dynamic `require(name)` would not
 * resolve at all, and a top-level import would break apps without the package.
 */
export function loadViewShot(): ViewShot | undefined {
  try {
    const mod = require('react-native-view-shot')
    return typeof mod?.captureScreen === 'function' ? mod : undefined
  } catch {
    return undefined
  }
}

export function captureTools(load: () => ViewShot | undefined): Tools {
  return {
    'screen.capture': {
      description: TOOL_DESCRIPTIONS['screen.capture'],
      maxArgs: 1,
      run: async (options?: { base64?: boolean; format?: 'png' | 'jpg'; quality?: number; maxBase64?: number }) => {
        const viewShot = load()
        if (!viewShot) throw new Error(UNAVAILABLE)
        const shape = {
          format: options?.format === 'jpg' ? ('jpg' as const) : ('png' as const),
          ...(typeof options?.quality === 'number' && { quality: options.quality }),
        }
        if (options?.base64) {
          const base64 = await viewShot.captureScreen({ ...shape, result: 'base64' })
          const max = Math.min(options.maxBase64 ?? MAX_BASE64_CHARS, MAX_BASE64_CEILING)
          if (base64.length <= max) return { base64 }
        }
        const path = await viewShot.captureScreen({ ...shape, result: 'tmpfile' })
        return { path }
      },
    },
  }
}
