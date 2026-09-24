import {
  CDP_GLOBAL,
  CDP_REPLY_BINDING,
  type CallMessage,
  toAsciiJson,
} from '../shared/protocol'
import type { Transport } from './types'

/**
 * Works in any React Native app served by Metro. The client evaluates one fixed
 * entry point with an ASCII-only JSON payload, and the app pushes the result
 * back through a CDP binding (Hermes can't `awaitPromise` RN's promises).
 */
export function cdpTransport(): Transport {
  return {
    name: 'cdp',
    start(context) {
      const g = globalThis as Record<string, unknown>
      const entry = {
        info: () => toAsciiJson(context.info()),
        dispatch: (payload: string) => {
          const call = JSON.parse(payload) as CallMessage
          void context.dispatch(call).then((result) => {
            const reply = g[CDP_REPLY_BINDING]
            if (typeof reply === 'function') reply(toAsciiJson(result))
          })
          return call.id
        },
      }
      g[CDP_GLOBAL] = entry
      return () => {
        if (g[CDP_GLOBAL] === entry) delete g[CDP_GLOBAL]
      }
    },
  }
}
