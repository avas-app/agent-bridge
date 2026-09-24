import { useEffect, useRef } from 'react'
import { Platform } from 'react-native'

import {
  type DeviceInfo,
  PROTOCOL_VERSION,
  RUNTIME_MARKER,
} from '../shared/protocol'
import { builtinTools } from './builtin-tools'
import { cdpTransport } from './cdp-transport'
import { createRegistry } from './registry'
import type { AgentBridgeOptions, Tools, TransportContext } from './types'

const randomId = () => Math.random().toString(36).slice(2, 10)

/** Starts the bridge outside React. Returns a function that stops it. */
export function startAgentBridge(options: AgentBridgeOptions = {}): () => void {
  const deviceId = randomId()
  const userTools = (): Tools =>
    typeof options.tools === 'function'
      ? options.tools()
      : (options.tools ?? {})
  const allTools = (): Tools => ({
    ...builtinTools(() => registry.list(), allTools),
    ...userTools(),
  })
  const registry = createRegistry(allTools)
  const info = (): DeviceInfo => ({
    deviceId,
    name: options.name ?? Platform.OS,
    platform: Platform.OS,
    protocol: PROTOCOL_VERSION,
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
    })
  }, [])
}

// Exported so the marker survives minification in every non-release bundle.
export { cdpTransport, RUNTIME_MARKER }
export type {
  AgentBridgeOptions,
  ToolDefinition,
  ToolFn,
  Tools,
  Transport,
} from './types'
export type {
  CallMessage,
  DeviceInfo,
  ResultMessage,
  ToolInfo,
} from '../shared/protocol'
