import { DevSettings } from 'react-native'

import type { Tools } from '../types'

export function appTools(): Tools {
  return {
    'app.reload': {
      description:
        'Reload the app\'s JS (DevSettings.reload). Pending restores (store, query, mocks, pins) are lost. Returns before it reloads; the bridge comes back with a new id, and a session reports what was lost.',
      run: () => {
        // Later, so this reply gets out and a client that retries a dropped call can't reload twice.
        setTimeout(() => DevSettings.reload(), 50)
        return { reloading: true }
      },
    },
  }
}
