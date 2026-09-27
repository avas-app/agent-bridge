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

export type ScenarioContext<O = unknown> = {
  /** What the agent or flow passed to `scenario.apply`, or undefined. */
  options: O | undefined
  /**
   * Calls any bridge tool by name, e.g. `call('store.set', 'auth', {...})`.
   * What a tool changes is undone by its own restorer in `bridge.restore`.
   */
  call: (tool: string, ...args: unknown[]) => Promise<unknown>
  /**
   * Runs `fn` when the scenario is undone, after every other restorer. Use it
   * for anything the tools' restorers don't cover: app mocks, gates, native
   * state. Undo callbacks run newest first.
   */
  onUndo: (fn: () => unknown) => void
}

/** A named setup the app defines and the agent applies, e.g. a signed-in user. */
export type Scenario<O = unknown> = {
  description?: string
  /** What `options` it takes, in words or as an example, for `scenario.list`. */
  options?: string
  /** Sets the app up. Its return value goes back to the agent. */
  apply: (context: ScenarioContext<O>) => unknown
}

// oxlint-disable-next-line no-explicit-any -- each scenario picks its own options type
export type Scenarios = Record<string, Scenario<any>>

export type AgentBridgeOptions = {
  /** Your tools, or a function returning them (read on every call). */
  tools?: Tools | (() => Tools)
  /** Named setups for `scenario.*`, or a function returning them (read on every call). */
  scenarios?: Scenarios | (() => Scenarios)
  /** How this app shows up in `agent-bridge devices`. */
  name?: string
  /** Defaults to CDP only. Add `expoTransport()` on Expo. */
  transports?: Transport[]
}
