import type { Tools } from '../types'

/** The slice of react-native-view-shot this tool uses. */
export type ViewShot = {
  captureScreen: (options: {
    format: 'png'
    result: 'tmpfile' | 'base64'
  }) => Promise<string>
}

// Base64 replies bigger than this fall back to a file path.
const MAX_BASE64_CHARS = 200_000

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
      description:
        'Screenshot the app as a PNG. Returns {path} of a file on the device. `{base64:true}` returns {base64} instead when small enough (else {path}). Only works if the app already has react-native-view-shot; otherwise errors and you use agent-device, simctl or adb.',
      maxArgs: 1,
      run: async (options?: { base64?: boolean }) => {
        const viewShot = load()
        if (!viewShot) throw new Error(UNAVAILABLE)
        if (options?.base64) {
          const base64 = await viewShot.captureScreen({
            format: 'png',
            result: 'base64',
          })
          if (base64.length <= MAX_BASE64_CHARS) return { base64 }
        }
        const path = await viewShot.captureScreen({
          format: 'png',
          result: 'tmpfile',
        })
        return { path }
      },
    },
  }
}
