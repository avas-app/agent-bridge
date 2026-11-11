import { type Area, deviceState, type ReactNativeLike } from './types'

const STATES = ['active', 'background', 'inactive']

// RN's own listener assigns currentState when we emit; the fake must ignore that.
let emitting = false

function emitState(rn: ReactNativeLike, state: string) {
  emitting = true
  try {
    rn.DeviceEventEmitter.emit('appStateDidChange', { app_state: state })
    if (rn.Platform?.OS === 'android') rn.DeviceEventEmitter.emit('appStateFocusChange', state === 'active')
  } finally {
    emitting = false
  }
}

/** `device.appState`: tell AppState listeners the app moved, and report it from `currentState`. */
export function appStateArea(rn: () => ReactNativeLike): Area {
  const restore = () => {
    const st = deviceState()
    const faked = st.appState
    if (!faked) return { restored: false }
    const { AppState } = rn()
    delete st.appState
    delete (AppState as { currentState?: string }).currentState
    AppState.currentState = faked.real
    if (faked.real !== faked.fake) emitState(rn(), faked.real)
    return { restored: true, state: faked.real }
  }

  return {
    pending: () => {
      const faked = deviceState().appState
      return faked ? { state: faked.fake, real: faked.real } : null
    },
    restore,
    tools: {
      'device.appState': {
        description:
          'Move the app to "active", "background" or "inactive": every AppState change listener fires and AppState.currentState reports it until device.restore. Real native changes still reach listeners meanwhile. Returns { state, previous }.',
        maxArgs: 1,
        run: (state: unknown) => {
          if (typeof state !== 'string' || !STATES.includes(state))
            throw new Error(`Pass one of: ${STATES.join(', ')}`)
          const native = rn()
          const { AppState } = native
          const st = deviceState()
          const previous = st.appState?.fake ?? AppState.currentState
          if (!st.appState) {
            const faked = { fake: state, real: AppState.currentState }
            st.appState = faked
            Object.defineProperty(AppState, 'currentState', {
              configurable: true,
              enumerable: true,
              get: () => deviceState().appState?.fake ?? faked.real,
              set: (value: string) => {
                if (!emitting && deviceState().appState) deviceState().appState!.real = value
              },
            })
          } else st.appState.fake = state
          emitState(native, state)
          return { state, previous }
        },
      },
    },
  }
}
