import {
  type DevToolsPluginClient,
  type EventSubscription,
  getDevToolsPluginClientAsync,
} from 'expo/devtools'

import type { Transport } from '../runtime/types'
import { type CallMessage, PLUGIN_NAME } from '../shared/protocol'

/**
 * Plain JSON over Expo's dev-tools plugin socket: no string evaluation, emoji
 * and async tools just work. Needs the Expo CLI dev server.
 */
export function expoTransport(): Transport {
  return {
    name: 'expo',
    start(context) {
      let closed = false
      let client: DevToolsPluginClient | null = null
      const subscriptions: EventSubscription[] = []

      void getDevToolsPluginClientAsync(PLUGIN_NAME).then((c) => {
        if (closed) {
          void c.closeAsync()
          return
        }
        client = c
        const announce = () => c.sendMessage('hello:reply', context.info())
        subscriptions.push(c.addMessageListener('hello', announce))
        subscriptions.push(
          c.addMessageListener('call', async (call: CallMessage) => {
            // The socket broadcasts; only answer calls meant for this device.
            if (call.to && call.to !== context.info().deviceId) return
            c.sendMessage('result', await context.dispatch(call))
          }),
        )
        announce()
      })

      return () => {
        closed = true
        for (const s of subscriptions) s.remove()
        void client?.closeAsync()
      }
    },
  }
}

export type { Transport }
