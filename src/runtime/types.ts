import type { CallMessage, DeviceInfo, ResultMessage } from '../shared/protocol'

// oxlint-disable-next-line no-explicit-any -- tools take whatever JSON the agent sends
export type ToolFn = (...args: any[]) => unknown

export type ToolDefinition = ToolFn | { description?: string; run: ToolFn }

/** Tools by name. Namespace them with a dot, e.g. `query.pin`. */
export type Tools = Record<string, ToolDefinition>

export type TransportContext = {
  info: () => DeviceInfo
  dispatch: (call: CallMessage) => Promise<ResultMessage>
}

export type Transport = {
  name: string
  /** Starts listening; returns a function that stops. */
  start: (context: TransportContext) => () => void
}

export type AgentBridgeOptions = {
  /** Your tools, or a function returning them (read on every call). */
  tools?: Tools | (() => Tools)
  /** How this app shows up in `agent-bridge devices`. */
  name?: string
  /** Defaults to CDP only. Add `expoTransport()` on Expo. */
  transports?: Transport[]
}
