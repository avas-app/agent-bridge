import type { Tools } from '../types'

export function appTools(reload: () => void): Tools {
  return {
    'app.reload': {
      description:
        "Reload the app's JS (DevSettings.reload). Pending restores (store, query, mocks, pins) are lost. Returns before it reloads; a session waits for the new bridge and reports what was lost.",
      run: () => {
        // Later, so this reply gets out first.
        setTimeout(reload, 50)
        return { reloading: true }
      },
    },
  }
}
