import type { Area, NotificationsLike, ReactNativeLike } from './types'

type Emitter = { emit: (event: string, payload: unknown) => void; listenerCount?: (event: string) => number }

let count = 0

// expo-notifications listens on its native module's emitter; older SDKs use
// the shared DeviceEventEmitter.
function emitter(rn: ReactNativeLike): { target: Emitter; via: string } {
  const native = (globalThis as { expo?: { modules?: Record<string, Emitter | undefined> } }).expo?.modules
    ?.ExpoNotificationsEmitter
  return typeof native?.emit === 'function'
    ? { target: native, via: 'ExpoNotificationsEmitter' }
    : { target: rn.DeviceEventEmitter, via: 'DeviceEventEmitter' }
}

/** `device.notification`: fake a push arriving or being tapped, for expo-notifications listeners. */
export function notificationArea(rn: () => ReactNativeLike, Notifications: NotificationsLike): Area {
  return {
    pending: () => null,
    restore: () => ({}),
    tools: {
      'device.notification': {
        description:
          'Deliver a push notification to expo-notifications listeners: [{ title?, body?, data? }, { tapped? }]. By default addNotificationReceivedListener fires (app open); { tapped: true } fires addNotificationResponseReceivedListener with the default action, as if the user tapped it. Returns { id, event, via, listeners }: which emitter it used and how many listeners it reached (0 means nothing heard it).',
        maxArgs: 2,
        run: (content: unknown, options: unknown = {}) => {
          if (!content || typeof content !== 'object' || Array.isArray(content))
            throw new Error('Pass { title, body, data }')
          const { tapped } = (options ?? {}) as { tapped?: boolean }
          const { title = null, body = null, data = {}, ...rest } = content as Record<string, unknown>
          const id = `agent-bridge-${++count}`
          const notification = {
            date: Date.now() / 1000,
            request: {
              identifier: id,
              content: { title, body, subtitle: null, sound: null, badge: null, data, ...rest },
              trigger: { type: 'push' },
            },
          }
          const { target, via } = emitter(rn())
          const send = (event: string, payload: unknown) => {
            target.emit(event, payload)
            return target.listenerCount?.(event)
          }
          if (tapped) {
            const listeners = send('onDidReceiveNotificationResponse', {
              notification,
              actionIdentifier:
                Notifications.DEFAULT_ACTION_IDENTIFIER ?? 'expo.modules.notifications.actions.DEFAULT',
            })
            return { id, event: 'response', via, listeners }
          }
          const listeners = send('onDidReceiveNotification', notification)
          return { id, event: 'received', via, listeners }
        },
      },
    },
  }
}
