import type { Tools } from '../runtime/types'
import { appStateArea } from './device/app-state'
import { clockArea } from './device/clock'
import { linkArea } from './device/link'
import { notificationArea } from './device/notification'
import { offlineArea } from './device/offline'
import { type Area, type DeviceToolsOptions, loadReactNative } from './device/types'

export type { DeviceToolsOptions, NetInfoLike, NotificationsLike, ReactNativeLike } from './device/types'

/**
 * Fake what comes from outside the JS: an incoming deep link, the app going
 * to the background, going offline, a push notification and (opt in) the clock.
 * `device.restore` undoes all of it.
 */
export function deviceTools(options: DeviceToolsOptions = {}): Tools {
  const rn = () => options.reactNative ?? loadReactNative()
  const areas: Area[] = [
    linkArea(rn, options.navigation),
    appStateArea(rn),
    offlineArea(rn, options.NetInfo),
  ]
  if (options.Notifications) areas.push(notificationArea(rn, options.Notifications))
  if (options.time) areas.push(clockArea())

  const tools: Tools = Object.assign({}, ...areas.map((a) => a.tools))
  tools['device.restore'] = {
    description: 'Undo every device event: deep link, app state, offline and clock.',
    pending: () => {
      const pending = Object.assign({}, ...areas.map((a) => a.pending()))
      return Object.keys(pending).length ? pending : false
    },
    run: () => Object.assign({}, ...areas.map((a) => a.restore())),
  }
  return tools
}
