import { pendingUndos, runUndos } from '../undo'
import type { Tools } from '../types'

/** The part of Expo's runtime global (`globalThis.expo`) that `app.reload` uses. */
export type ExpoHost = {
  expo?: { reloadAppAsync?: (reason?: string) => Promise<void> | void }
}

/**
 * Picks how to reload the JS. Expo (SDK 51+) installs
 * `globalThis.expo.reloadAppAsync`, which reloads through Expo's host (Expo Go,
 * dev clients); `reloadAppAsync` from 'expo' only wraps it, so reading the
 * global needs no import. `DevSettings.reload()` is for apps without Expo: in
 * Expo Go it reloads the bundle without Expo's native modules and the app dies
 * with "Cannot find native module 'ExpoAsset'" (#52). Falls back to it if
 * Expo's reload fails.
 */
export function selectReload(
  host: ExpoHost,
  devSettingsReload: () => void,
): () => void {
  return () => {
    const expo = host.expo
    if (typeof expo?.reloadAppAsync !== 'function') return devSettingsReload()
    try {
      Promise.resolve(expo.reloadAppAsync('agent-bridge app.reload')).catch(
        () => devSettingsReload(),
      )
    } catch {
      devSettingsReload()
    }
  }
}

export function appTools(reload: () => void): Tools {
  return {
    'app.reload': {
      description:
        "Reload the app's JS (Expo's reloadAppAsync, else DevSettings.reload). Pending restores (store, query, mocks, pins) are lost. Returns before it reloads; a session waits for the new bridge and reports what was lost.",
      run: () => {
        // Later, so this reply gets out first.
        setTimeout(reload, 50)
        return { reloading: true }
      },
    },
    'app.restore': {
      maxArgs: 0,
      // The labels, so bridge.pending shows what the app's own tools changed.
      pending: () => {
        const labels = pendingUndos()
        return labels.length ? labels : false
      },
      description:
        "Undo what the app's own tools changed: runs the undos they registered with onRestore, newest first, once. Returns how many ran.",
      run: async () => {
        const { ran, errors } = await runUndos()
        // Throws so bridge.restore and flows still see a failure, with the count that did run.
        if (errors.length)
          throw new Error(`${errors.join('; ')} (${ran - errors.length} of ${ran} undone)`)
        return { undone: ran }
      },
    },
  }
}
