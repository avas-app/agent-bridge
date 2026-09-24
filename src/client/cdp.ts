import WebSocket from 'ws'

import {
  CDP_GLOBAL,
  CDP_REPLY_BINDING,
  type CallMessage,
  type DeviceInfo,
  type ResultMessage,
  toAsciiJson,
} from '../shared/protocol'
import {
  type Connection,
  createPending,
  newCallId,
  openSocket,
} from './connection'
import {
  type CdpTarget,
  expoHostUri,
  listCdpTargets,
  pickOne,
} from './discover'

class CannotEvaluate extends Error {}

const targetLabel = (t: CdpTarget) =>
  `${t.title}${t.deviceName ? ` [${t.deviceName}]` : ''}`

export async function connectCdp(
  metro: string,
  device?: string,
): Promise<Connection> {
  const target = pickOne(await listCdpTargets(metro), device, targetLabel)
  const hostUri = await expoHostUri(metro)
  const port = metro.split(':')[1] ?? '8081'
  // Expo wants its advertised host exactly; bare RN accepts any localhost origin.
  const origin = hostUri ? `http://${hostUri}` : `http://localhost:${port}`

  // Metro accepts the upgrade and then drops a socket with the wrong Origin,
  // so a close before the first reply is reported with the Origin we sent.
  const closedEarly = `Metro closed the debugger socket. Origin sent: ${origin}. Is that the host Metro advertises?`
  const ws = await openSocket(target.webSocketDebuggerUrl, {
    Origin: origin,
  }).catch(() => {
    throw new Error(closedEarly)
  })

  type Command = {
    resolve: (m: Record<string, any>) => void
    reject: (e: Error) => void
  }
  let seq = 0
  let answered = false
  const commands = new Map<number, Command>()
  const pending = createPending()
  ws.on('message', (data) => {
    const message = JSON.parse(String(data))
    if (message.id && commands.has(message.id)) {
      answered = true
      commands.get(message.id)?.resolve(message)
      commands.delete(message.id)
    } else if (
      message.method === 'Runtime.bindingCalled' &&
      message.params?.name === CDP_REPLY_BINDING
    ) {
      pending.settle(JSON.parse(message.params.payload) as ResultMessage)
    }
  })
  ws.on('close', () => {
    const reason = answered ? 'The debugger socket closed' : closedEarly
    for (const command of commands.values()) command.reject(new Error(reason))
    commands.clear()
    pending.failAll(reason)
  })

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, any>>((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error(answered ? 'The debugger socket closed' : closedEarly))
        return
      }
      const id = ++seq
      commands.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async (expression: string) => {
    const message = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    })
    // -32601: the debugger has no Runtime.evaluate (Expo Go on Android).
    if (message.error?.code === -32601) throw new CannotEvaluate()
    const details = message.result?.exceptionDetails
    if (details) {
      const text: string =
        details.exception?.description ?? details.text ?? 'evaluation failed'
      throw new Error(text.split('\n')[0])
    }
    return message.result?.result?.value as unknown
  }

  await send('Runtime.enable')
  await send('Runtime.addBinding', { name: CDP_REPLY_BINDING })

  let info: DeviceInfo
  try {
    info = JSON.parse(
      String(await evaluate(`${CDP_GLOBAL}.info()`)),
    ) as DeviceInfo
  } catch (error) {
    ws.close()
    throw new Error(
      error instanceof CannotEvaluate
        ? `The debugger for ${targetLabel(target)} can't run code (no Runtime.evaluate, as in Expo Go on Android). Use --transport expo, or a dev build.`
        : `agent-bridge isn't running in ${targetLabel(target)}. Is useAgentBridge mounted in a dev build?`,
    )
  }

  return {
    transport: 'cdp',
    device: { ...info, name: `${info.name} (${targetLabel(target)})` },
    async call(tool, args, timeoutMs) {
      const call: CallMessage = { id: newCallId(), tool, args }
      const reply = pending.wait(call.id, tool, timeoutMs)
      try {
        // The payload travels as ASCII-only JSON inside a string literal.
        await evaluate(
          `${CDP_GLOBAL}.dispatch(${JSON.stringify(toAsciiJson(call))})`,
        )
      } catch (error) {
        pending.settle({
          id: call.id,
          from: info.deviceId,
          ok: false,
          error: String(error),
          ms: 0,
        })
      }
      return reply
    },
    close: () => ws.close(),
  }
}
