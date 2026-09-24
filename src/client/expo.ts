import {
  type CallMessage,
  type DeviceInfo,
  PLUGIN_NAME,
  type ResultMessage,
} from '../shared/protocol'
import {
  type Connection,
  createPending,
  newCallId,
  openSocket,
} from './connection'
import { pickOne } from './discover'

type Frame = {
  messageKey?: { pluginName?: string; method?: string }
  payload?: unknown
}

const deviceLabel = (d: DeviceInfo) =>
  `${d.name} (${d.platform}, ${d.deviceId})`

/** Opens Expo's broadcast socket and asks every app with the bridge to say hello. */
async function openBroadcast(metro: string, discoveryMs: number) {
  const ws = await openSocket(`ws://${metro}/expo-dev-plugins/broadcast`)
  const devices = new Map<string, DeviceInfo>()
  const pending = createPending()
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    let frame: Frame
    try {
      frame = JSON.parse(String(data)) as Frame
    } catch {
      return
    }
    if (frame.messageKey?.pluginName !== PLUGIN_NAME) return
    if (frame.messageKey.method === 'hello:reply') {
      const info = frame.payload as DeviceInfo
      devices.set(info.deviceId, info)
    } else if (frame.messageKey.method === 'result') {
      pending.settle(frame.payload as ResultMessage)
    }
  })
  ws.on('close', () => pending.failAll("Expo's dev-tools socket closed"))

  const send = (method: string, payload: unknown) =>
    ws.send(
      JSON.stringify({
        messageKey: { pluginName: PLUGIN_NAME, method },
        payload,
      }),
    )

  send('hello', {})
  await new Promise((r) => setTimeout(r, discoveryMs))
  return { ws, devices, pending, send }
}

export async function listExpoDevices(
  metro: string,
  discoveryMs = 600,
): Promise<DeviceInfo[]> {
  const { ws, devices } = await openBroadcast(metro, discoveryMs)
  ws.close()
  return [...devices.values()]
}

export async function connectExpo(
  metro: string,
  device?: string,
  discoveryMs = 600,
): Promise<Connection> {
  const { ws, devices, pending, send } = await openBroadcast(metro, discoveryMs)
  let info: DeviceInfo
  try {
    info = pickOne([...devices.values()], device, deviceLabel)
  } catch (error) {
    ws.close()
    throw error
  }
  return {
    transport: 'expo',
    device: info,
    call(tool, args, timeoutMs) {
      const call: CallMessage = {
        id: newCallId(),
        tool,
        args,
        to: info.deviceId,
      }
      const reply = pending.wait(call.id, tool, timeoutMs)
      send('call', call)
      return reply
    },
    close: () => ws.close(),
  }
}
