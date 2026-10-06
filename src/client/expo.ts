import {
  type CallMessage,
  type DeviceInfo,
  PLUGIN_NAME,
  type ResultMessage,
} from '../shared/protocol'
import {
  type AppPin,
  type Connection,
  createPending,
  describePin,
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
async function openBroadcast(
  metro: string,
  discoveryMs: number,
  signal?: AbortSignal,
) {
  const ws = await openSocket(
    `ws://${metro}/expo-dev-plugins/broadcast`,
    undefined,
    signal,
  )
  const devices = new Map<string, DeviceInfo>()
  const pending = createPending()
  const announced: Array<(info: DeviceInfo) => void> = []
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
      const fresh = !devices.has(info.deviceId)
      devices.set(info.deviceId, info)
      if (fresh) for (const listener of announced) listener(info)
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
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      ws.terminate()
      reject(new Error('aborted while waiting for hello replies'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, discoveryMs)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
  return { ws, devices, pending, send, announced }
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
  signal?: AbortSignal,
  pin?: AppPin,
): Promise<Connection> {
  const { ws, devices, pending, send, announced } = await openBroadcast(
    metro,
    discoveryMs,
    signal,
  )
  let info: DeviceInfo
  try {
    const all = [...devices.values()]
    const candidates = pin
      ? all.filter((d) => d.name === pin.name && d.platform === pin.platform)
      : all
    if (pin && !candidates.length)
      throw new Error(
        `${describePin(pin)} is not connected; connected: ${all.map(deviceLabel).join('; ') || 'none'}`,
      )
    info = pickOne(candidates, device, deviceLabel)
  } catch (error) {
    ws.close()
    throw error
  }
  // A reloaded app announces itself under a new id and ignores calls to the
  // old one, so fail them now instead of letting each wait out its timeout.
  let superseded: string | null = null
  announced.push((next) => {
    if (
      superseded ||
      next.name !== info.name ||
      next.platform !== info.platform
    )
      return
    superseded = `${info.name} announced a new bridge (${next.deviceId}); the app reloaded`
    pending.failAll(superseded)
  })
  return {
    transport: 'expo',
    device: info,
    pin: { name: info.name, platform: info.platform },
    call(tool, args, timeoutMs) {
      if (superseded)
        return Promise.resolve<ResultMessage>({
          id: '',
          from: '',
          ok: false,
          error: superseded,
          ms: 0,
        })
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
