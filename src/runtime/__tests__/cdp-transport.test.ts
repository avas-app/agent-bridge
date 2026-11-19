import { expect, test } from 'bun:test'

import {
  CDP_GLOBAL,
  CDP_REPLY_BINDING,
  type DeviceInfo,
  type ResultMessage,
} from '../../shared/protocol'
import { cdpTransport } from '../cdp-transport'

const info: DeviceInfo = {
  deviceId: 'dev',
  name: 'test',
  platform: 'ios',
  protocol: 1,
  tools: [],
}

test('replies with a failed result when dispatch rejects', async () => {
  const g = globalThis as Record<string, unknown>
  let reply: ResultMessage | undefined
  g[CDP_REPLY_BINDING] = (ascii: string) => {
    reply = JSON.parse(ascii) as ResultMessage
  }
  const stop = cdpTransport().start({
    info: () => info,
    dispatch: () => Promise.reject(new Error('boom')),
  })
  try {
    const entry = g[CDP_GLOBAL] as { dispatch: (payload: string) => string }
    entry.dispatch(JSON.stringify({ id: 'call-1', tool: 'bridge.ping' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    stop()
    delete g[CDP_REPLY_BINDING]
  }
  expect(reply).toMatchObject({ id: 'call-1', from: 'dev', ok: false, error: 'boom' })
})
