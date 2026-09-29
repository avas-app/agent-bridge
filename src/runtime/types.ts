import type { CallMessage, DeviceInfo, ResultMessage } from '../shared/protocol'
import type { OptionsSchema } from './options-schema'

// oxlint-disable-next-line no-explicit-any -- tools take whatever JSON the agent sends
export type ToolFn = (...args: any[]) => unknown

export type ToolDefinition =
  | ToolFn
  | {
      description?: string
      /**
       * The most arguments `run` takes. A call with more fails instead of
       * dropping the extras, so a mis-shaped call is not read as a success.
       */
      maxArgs?: number
      run: ToolFn
      /**
       * On a `*.restore` tool: whether the agent has changed something it
       * would undo. A session reports these areas if the app reloads.
       * Return a falsy value for nothing; a truthy one is shown by
       * `bridge.pending` as the detail (`true` for none), e.g. what it will
       * put back. Only `bridge.pending` passes `{ detail: true }`; replies
       * call it bare, so build the detail only when asked.
       */
      pending?: (options?: { detail?: boolean }) => unknown
    }

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
  /**
   * JSON Schema (2020-12) for `options`. `scenario.apply` rejects options
   * that don't fit before `apply` runs, and `scenario.list` shows it. Keys an
   * object schema doesn't list are rejected unless it sets
   * `additionalProperties`. No options are checked as `{}`.
   */
  options?: OptionsSchema
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
