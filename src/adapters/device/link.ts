import { settle as settleScreen } from '../../runtime/screen/settle'
import type { NavigationLike } from '../expo-router'
import { routeFromState, settle } from '../expo-router-route'
import { type Area, deviceState, type ReactNativeLike } from './types'

type Emitter = { emit: (event: string, payload: unknown) => void; listenerCount?: (event: string) => number }

// expo-linking's useLinkingURL() listens on its native module's emitter, not on Linking.
const expoLinking = () =>
  (globalThis as { expo?: { modules?: Record<string, Emitter | undefined> } }).expo?.modules?.ExpoLinking

/** `device.openUrl`: deliver an incoming deep link to the app's `url` listeners. */
export function linkArea(rn: () => ReactNativeLike, navigation?: NavigationLike): Area {
  const restore = () => {
    const st = deviceState()
    const had = st.origGetInitialURL !== undefined
    if (had) rn().Linking.getInitialURL = st.origGetInitialURL!
    const url = st.initialUrl
    delete st.origGetInitialURL
    delete st.initialUrl
    return { restored: had, ...(url && { url }) }
  }

  return {
    pending: () => {
      const { initialUrl } = deviceState()
      return initialUrl ? { initialUrl } : null
    },
    restore,
    tools: {
      'device.openUrl': {
        description:
          'Deliver an incoming deep link, e.g. ["myapp://orders/5"], to every Linking "url" listener and, when the native expo-linking module exists, its useLinkingURL() hook without leaving the app, and make Linking.getInitialURL() return it until device.restore. getLinkingURL() still reads the native value. A cold start already read its URL, so this tests links that arrive while the app runs. Returns { url, listeners } and, with the navigation container, the route the app ended on.',
        maxArgs: 1,
        run: async (url: unknown) => {
          if (typeof url !== 'string' || !url) throw new Error('Pass the URL, e.g. "myapp://orders/5"')
          const { Linking, DeviceEventEmitter } = rn()
          const st = deviceState()
          if (st.origGetInitialURL === undefined) {
            st.origGetInitialURL = Linking.getInitialURL
            Linking.getInitialURL = () => Promise.resolve(deviceState().initialUrl ?? null)
          }
          st.initialUrl = url
          const native = expoLinking()
          const emit = () => {
            DeviceEventEmitter.emit('url', { url })
            if (typeof native?.emit === 'function') native.emit('onURLReceived', { url })
          }
          const listeners = DeviceEventEmitter.listenerCount?.('url')
          if (!navigation || (navigation.isReady && !navigation.isReady())) {
            emit()
            return { url, listeners }
          }
          await settle(navigation, emit)
          await settleScreen()
          const route = routeFromState(navigation.getRootState() as never)
          return { url, listeners, route }
        },
      },
    },
  }
}
