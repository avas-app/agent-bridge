import { setDeviceOffline } from '../../network/state'
import type { Area, NetInfoLike, ReactNativeLike } from './types'
import { deviceState } from './types'

const NETINFO_EVENT = 'netInfo.networkStatusDidChange'
const NONE = { type: 'none', isConnected: false, isInternetReachable: false, details: null }

/** `device.offline`: make fetch, XHR and NetInfo see no network. */
export function offlineArea(rn: () => ReactNativeLike, NetInfo?: NetInfoLike): Area {
  let origRefresh: NetInfoLike['refresh']

  const restore = () => {
    const st = deviceState()
    if (!st.offline) return { restored: false }
    st.offline = false
    setDeviceOffline(false)
    if (NetInfo && origRefresh) {
      NetInfo.refresh = origRefresh
      origRefresh = undefined
      // The real state comes back through NetInfo's own check.
      Promise.resolve(NetInfo.refresh()).catch(() => {})
    }
    return { restored: true }
  }

  return {
    pending: () => (deviceState().offline ? { offline: true, netInfo: Boolean(NetInfo) } : null),
    restore,
    tools: {
      'device.offline': {
        description:
          'device.offline true makes every fetch and XHR fail like no network (mocks included; Metro stays reachable) and, when NetInfo was passed in, tells its listeners, NetInfo.fetch and useNetInfo the device is offline. false goes back. device.restore also does. Returns { offline }.',
        maxArgs: 1,
        run: (offline: unknown) => {
          if (typeof offline !== 'boolean') throw new Error('Pass true or false')
          if (!offline) {
            restore()
            return { offline: false }
          }
          const st = deviceState()
          st.offline = true
          setDeviceOffline(true)
          if (NetInfo) {
            if (!origRefresh && typeof NetInfo.refresh === 'function') {
              origRefresh = NetInfo.refresh
              // A refresh would read the real, online state back in.
              NetInfo.refresh = () => Promise.resolve(NONE)
            }
            rn().DeviceEventEmitter.emit(NETINFO_EVENT, NONE)
          }
          return { offline: true }
        },
      },
    },
  }
}
