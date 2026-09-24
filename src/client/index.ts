import type { DeviceInfo, LogEntry, ToolInfo } from '../shared/protocol'
import { connectCdp } from './cdp'
import type { Connection, TransportName } from './connection'
import { listCdpTargets, metroHost } from './discover'
import { connectExpo, listExpoDevices } from './expo'

export type ConnectOptions = {
  /** Metro's host:port. Defaults to $AGENT_BRIDGE_METRO, then localhost:8081. */
  metro?: string
  /** Part of the app's name or device name, when more than one is connected. */
  device?: string
  /** "auto" tries Expo's socket first and falls back to CDP. */
  transport?: 'auto' | TransportName
  /** Per-call timeout. Default 10 s. */
  timeoutMs?: number
}

export class AgentBridgeCallError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    /** Errors the app attached to the failed reply. */
    readonly logs: LogEntry[] = [],
  ) {
    super(`${tool}: ${message}`)
    this.name = 'AgentBridgeCallError'
  }
}

/** `logs`: errors the app recorded since its previous reply. */
export type Timed<T> = {
  value: T
  ms: number
  appMs: number
  logs: LogEntry[]
}

export type AgentBridge = {
  transport: TransportName
  device: DeviceInfo
  /** Calls a tool and returns its value; throws AgentBridgeCallError if the tool threw. */
  call: <T = unknown>(tool: string, ...args: unknown[]) => Promise<NoInfer<T>>
  /** Like `call`, plus the round trip and the time spent inside the app. */
  timed: <T = unknown>(
    tool: string,
    ...args: unknown[]
  ) => Promise<Timed<NoInfer<T>>>
  tools: () => ToolInfo[]
  close: () => void
}

export async function connect(
  options: ConnectOptions = {},
): Promise<AgentBridge> {
  const metro = metroHost(options.metro)
  const want = options.transport ?? 'auto'
  const timeoutMs = options.timeoutMs ?? 10_000

  let connection: Connection | undefined
  let expoError: unknown
  if (want !== 'cdp') {
    try {
      connection = await connectExpo(metro, options.device)
    } catch (error) {
      if (want === 'expo') throw error
      expoError = error
    }
  }
  if (!connection) {
    try {
      connection = await connectCdp(metro, options.device)
    } catch (error) {
      const expoNote = expoError ? ` (Expo socket: ${String(expoError)})` : ''
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${expoNote}`,
      )
    }
  }

  const conn = connection
  const timed = async <T>(
    tool: string,
    ...args: unknown[]
  ): Promise<Timed<T>> => {
    const t0 = performance.now()
    const result = await conn.call(tool, args, timeoutMs)
    const ms = performance.now() - t0
    const logs = result.logs ?? []
    if (!result.ok) throw new AgentBridgeCallError(tool, result.error, logs)
    return { value: result.value as T, ms, appMs: result.ms, logs }
  }

  return {
    transport: conn.transport,
    device: conn.device,
    timed,
    call: async <T>(tool: string, ...args: unknown[]) =>
      (await timed<T>(tool, ...args)).value,
    tools: () => conn.device.tools,
    close: conn.close,
  }
}

export type ListedDevice = {
  transport: TransportName
  name: string
  deviceId?: string
  tools?: number
}

/** Apps with the bridge on Expo's socket, plus every React Native page Metro knows. */
export async function listDevices(
  options: Pick<ConnectOptions, 'metro'> = {},
): Promise<ListedDevice[]> {
  const metro = metroHost(options.metro)
  const [expo, cdp] = await Promise.all([
    listExpoDevices(metro).catch(() => []),
    listCdpTargets(metro).catch(() => []),
  ])
  return [
    ...expo.map((d) => ({
      transport: 'expo' as const,
      name: d.name,
      deviceId: d.deviceId,
      tools: d.tools.length,
    })),
    ...cdp.map((t) => ({
      transport: 'cdp' as const,
      name: `${t.title}${t.deviceName ? ` [${t.deviceName}]` : ''}`,
    })),
  ]
}

export type { DeviceInfo, LogEntry, ToolInfo } from '../shared/protocol'
export type { TransportName } from './connection'
