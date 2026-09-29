import { useEffect, useRef } from 'react'
import { Platform } from 'react-native'

import {
  type DeviceInfo,
  PROTOCOL_VERSION,
  RUNTIME_MARKER,
} from '../shared/protocol'
import { builtinTools } from './builtin-tools'
import { cdpTransport } from './cdp-transport'
import { createGate } from './gate'
import { loadId } from './load-id'
import { startLogCapture } from './logs'
import { createRegistry } from './registry'
import { settle } from './screen/settle'
import type { AgentBridgeOptions, Tools, TransportContext } from './types'

const randomId = () => Math.random().toString(36).slice(2, 10)

/** Starts the bridge outside React. Returns a function that stops it. */
export function startAgentBridge(options: AgentBridgeOptions = {}): () => void {
  const deviceId = randomId()
  const userTools = (): Tools =>
    typeof options.tools === 'function'
      ? options.tools()
      : (options.tools ?? {})
  const { scenarios } = options
  const getScenarios = scenarios
    ? () => (typeof scenarios === 'function' ? scenarios() : scenarios)
    : undefined
  const logs = startLogCapture()
  const allTools = (): Tools => ({
    ...builtinTools(() => registry.list(), allTools, logs.capture, getScenarios),
    ...userTools(),
  })
  const registry = createRegistry(allTools, logs.capture, loadId)
  const info = (): DeviceInfo => ({
    deviceId,
    name: options.name ?? Platform.OS,
    platform: Platform.OS,
    protocol: PROTOCOL_VERSION,
    loadId,
    tools: registry.list(),
  })
  const context: TransportContext = {
    info,
    dispatch: (call) => registry.dispatch(call, deviceId),
  }
  const stops = (options.transports ?? [cdpTransport()]).map((t) =>
    t.start(context),
  )
  return () => {
    for (const stop of stops) stop()
    logs.stop()
  }
}

/**
 * Exposes `tools` to coding agents while mounted. Tools are read on every call,
 * so passing a fresh object each render is fine. Transports start once.
 */
export function useAgentBridge(options: AgentBridgeOptions = {}): void {
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })
  useEffect(() => {
    const { transports, name } = latest.current
    return startAgentBridge({
      name,
      transports,
      tools: () => {
        const { tools } = latest.current
        return typeof tools === 'function' ? tools() : (tools ?? {})
      },
      // Decided at mount: scenario.* tools are there or not for the bridge's life.
      scenarios: latest.current.scenarios
        ? () => {
            const { scenarios } = latest.current
            return typeof scenarios === 'function' ? scenarios() : (scenarios ?? {})
          }
        : undefined,
    })
  }, [])
}

// Exported so the marker survives minification in every non-release bundle.
export { cdpTransport, RUNTIME_MARKER }
// For app side effects a scenario must hold off, e.g. a realtime connection.
export { createGate }
export type { Gate } from './gate'
export type { OptionsSchema } from './options-schema'
// For custom tools that change what's on screen: await settle() before
// returning so the agent's next check sees the render.
export { settle }
export type { SettleResult } from './screen/settle'
export type { ScreenElement, Target } from './screen'
export type {
  AgentBridgeOptions,
  Scenario,
  ScenarioContext,
  Scenarios,
  ToolDefinition,
  ToolFn,
  Tools,
  Transport,
} from './types'
export type {
  CallMessage,
  DeviceInfo,
  LogEntry,
  ResultMessage,
  ToolInfo,
} from '../shared/protocol'
