import { pendingUndos, runUndos } from '../undo'
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
        if (errors.length) throw new Error(errors.join('; '))
        return { undone: ran }
      },
    },
  }
}
