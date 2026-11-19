import {
  CDP_GLOBAL,
  CDP_REPLY_BINDING,
  type CallMessage,
  failedResult,
  type ResultMessage,
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
          const reply = (result: ResultMessage) => {
            const send = g[CDP_REPLY_BINDING]
            if (typeof send === 'function') send(toAsciiJson(result))
          }
          void context.dispatch(call).then(reply, (error: unknown) =>
            reply(failedResult(call.id, context.info().deviceId, error)),
          )
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
