#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import {
  type AgentBridge,
  type ConnectOptions,
  connect,
  listDevices,
} from './client/index'
import {
  DAEMON_COMMAND,
  daemonMain,
  sessionCommand,
  sessionFor,
} from './client/session/cli'
import { connectSession } from './client/session/client'
import { RUNTIME_MARKER } from './shared/protocol'

const HELP = `agent-bridge: drive a running React Native app from an agent

Usage
  agent-bridge devices                    Apps connected to Metro
  agent-bridge tools                      Tools the app exposes
  agent-bridge call <tool> [args]         Call a tool. args: a JSON array, or one JSON value
  agent-bridge run <flow.mjs|.ts>         Run a flow: export default async ({ step, call }) => {}
  agent-bridge assert-absent <files...>   Fail if a release bundle contains the bridge

Sessions: one connection for all of an agent's calls
  agent-bridge session start [--name n] [--idle 15m]   Connect once in the background
  agent-bridge session stop [--name n] [--keep]        bridge.restore (unless --keep), then end
  agent-bridge session list | status [--name n]
  While a session matches --metro/--device, call, tools and run use it.

Options
  --metro <host:port>    Metro dev server (env AGENT_BRIDGE_METRO, default localhost:8081)
  --device <text>        Pick an app when several are connected
  --transport <name>     auto (default), expo or cdp
  --timeout <ms>         Per-call timeout (default 10000)
  --session <name>       Use this session (env AGENT_BRIDGE_SESSION)
  --no-session           Connect directly even if a session is running
`

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
      name: { type: 'string' },
      idle: { type: 'string' },
      keep: { type: 'boolean' },
      session: { type: 'string' },
      'no-session': { type: 'boolean' },
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
    const session = sessionFor(values)
    const bridge = session
      ? await connectSession({
          name: session.name,
          timeoutMs: options.timeoutMs,
        })
      : await connect(options)
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
        const { value, ms, appMs } = await bridge.timed(
          tool,
          ...parseCallArgs(raw),
        )
        console.log(JSON.stringify(value, null, 2))
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
        const t0 = performance.now()
        const step = async (
          label: string,
          tool: string,
          ...args: unknown[]
        ) => {
          const { value, ms } = await bridge.timed(tool, ...args)
          total += ms
          console.log(
            `${String(++n).padStart(2, '0')} ${label.padEnd(30)} ${ms.toFixed(1).padStart(7)} ms`,
          )
          return value
        }
        await flow.default({ bridge, call: bridge.call, step })
        console.log(
          `${n} steps, ${total.toFixed(1)} ms in calls, ${(performance.now() - t0).toFixed(0)} ms wall (${bridge.transport})`,
        )
      })
    }
    case 'session':
      return sessionCommand(rest[0], values)
    case DAEMON_COMMAND:
      return daemonMain(values)
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
