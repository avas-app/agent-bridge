#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import {
  type AgentBridge,
  AgentBridgeCallError,
  type ConnectOptions,
  connect,
  type LogEntry,
  listDevices,
  type Timed,
} from './client/index'
import { logLine } from './client/log-lines'
import { RUNTIME_MARKER } from './shared/protocol'

const HELP = `agent-bridge: drive a running React Native app from an agent

Usage
  agent-bridge devices                    Apps connected to Metro
  agent-bridge tools                      Tools the app exposes
  agent-bridge call <tool> [args]         Call a tool. args: a JSON array, or one JSON value
  agent-bridge run <flow.mjs|.ts>         Run a flow: export default async ({ step, call }) => {}
  agent-bridge assert-absent <files...>   Fail if a release bundle contains the bridge

Options
  --metro <host:port>    Metro dev server (env AGENT_BRIDGE_METRO, default localhost:8081)
  --device <text>        Pick an app when several are connected
  --transport <name>     auto (default), expo or cdp
  --timeout <ms>         Per-call timeout (default 10000)
  --strict               run: exit non-zero if the app logged an error
`

/** Errors a failed call brought back, for printing before the failure. */
const failedLogs = (error: unknown): LogEntry[] =>
  error instanceof AgentBridgeCallError ? error.logs : []

function parseCallArgs(raw: string | undefined): unknown[] {
  if (raw === undefined) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return [raw]
  }
  return Array.isArray(value) ? value : [value]
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      metro: { type: 'string' },
      device: { type: 'string' },
      transport: { type: 'string' },
      timeout: { type: 'string' },
      strict: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...rest] = positionals
  if (!command || values.help) {
    process.stdout.write(HELP)
    return
  }
  const options: ConnectOptions = {
    metro: values.metro,
    device: values.device,
    transport: values.transport as ConnectOptions['transport'],
    timeoutMs: values.timeout ? Number(values.timeout) : undefined,
  }
  const withBridge = async (fn: (bridge: AgentBridge) => Promise<void>) => {
    const bridge = await connect(options)
    try {
      await fn(bridge)
    } finally {
      bridge.close()
    }
  }

  switch (command) {
    case 'devices': {
      const devices = await listDevices(options)
      if (!devices.length) console.log('No apps connected.')
      for (const d of devices) {
        const extra =
          d.tools !== undefined ? `  ${d.tools} tools  ${d.deviceId}` : ''
        console.log(`${d.transport.padEnd(5)} ${d.name}${extra}`)
      }
      return
    }
    case 'tools':
      return withBridge(async (bridge) => {
        console.log(`${bridge.device.name} via ${bridge.transport}`)
        for (const t of bridge.tools())
          console.log(`  ${t.name.padEnd(22)} ${t.description ?? ''}`)
      })
    case 'call': {
      const [tool, raw] = rest
      if (!tool) throw new Error('Usage: agent-bridge call <tool> [args]')
      return withBridge(async (bridge) => {
        const { value, ms, appMs, logs } = await bridge
          .timed(tool, ...parseCallArgs(raw))
          .catch((error: unknown) => {
            for (const e of failedLogs(error)) console.error(logLine(e))
            throw error
          })
        console.log(JSON.stringify(value, null, 2))
        for (const e of logs) console.error(logLine(e))
        console.error(
          `${tool} via ${bridge.transport}: ${ms.toFixed(1)} ms round trip, ${appMs} ms in the app`,
        )
      })
    }
    case 'run': {
      const [file] = rest
      if (!file) throw new Error('Usage: agent-bridge run <flow file>')
      const flow = (await import(pathToFileURL(resolve(file)).href)) as {
        default: (api: {
          bridge: AgentBridge
          call: AgentBridge['call']
          step: (
            label: string,
            tool: string,
            ...args: unknown[]
          ) => Promise<unknown>
        }) => Promise<void>
      }
      return withBridge(async (bridge) => {
        let n = 0
        let total = 0
        let errors = 0
        const t0 = performance.now()
        const report = (logs: LogEntry[]) => {
          errors += logs.length
          for (const e of logs) console.log(`   ${logLine(e)}`)
        }
        // Every call the flow makes reports the errors its reply carried.
        const timed = async <T>(
          tool: string,
          ...args: unknown[]
        ): Promise<Timed<T>> => {
          try {
            const result = await bridge.timed<T>(tool, ...args)
            report(result.logs)
            return result
          } catch (error) {
            report(failedLogs(error))
            throw error
          }
        }
        const call = async <T>(tool: string, ...args: unknown[]) =>
          (await timed<T>(tool, ...args)).value
        const step = async (
          label: string,
          tool: string,
          ...args: unknown[]
        ) => {
          const { value, ms, logs } = await bridge.timed(tool, ...args).catch(
            (error: unknown) => {
              report(failedLogs(error))
              throw error
            },
          )
          total += ms
          console.log(
            `${String(++n).padStart(2, '0')} ${label.padEnd(30)} ${ms.toFixed(1).padStart(7)} ms`,
          )
          report(logs)
          return value
        }
        await flow.default({ bridge: { ...bridge, timed, call }, call, step })
        console.log(
          `${n} steps, ${total.toFixed(1)} ms in calls, ${(performance.now() - t0).toFixed(0)} ms wall (${bridge.transport})${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}`,
        )
        if (values.strict && errors) process.exitCode = 1
      })
    }
    case 'assert-absent': {
      if (!rest.length)
        throw new Error('Usage: agent-bridge assert-absent <bundle files...>')
      const found: string[] = []
      for (const file of rest) {
        if ((await readFile(file)).includes(RUNTIME_MARKER)) found.push(file)
      }
      if (found.length) {
        console.error(
          `agent-bridge is in a release bundle: ${found.join(', ')}`,
        )
        process.exitCode = 1
      } else {
        console.log(`agent-bridge is absent from ${rest.length} file(s).`)
      }
      return
    }
    default:
      throw new Error(`Unknown command "${command}".\n\n${HELP}`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
