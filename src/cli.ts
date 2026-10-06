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
} from './client/index'
import {
  type FlowModule,
  flowScenarios,
  parseScenarioFlag,
  runFlow,
} from './client/flow'
import { parseCallArgv, readArgFile, runBatch } from './client/batch'
import { logLine } from './client/log-lines'
import { renderResult } from './client/output'
import { DEFAULT_HISTORY_FILE, runRepl } from './client/repl'
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
  agent-bridge call <tool> @args.json     Same, read from a file (@- is stdin): no argv size limit
  agent-bridge call <tool> '"/feed"' @feed.json
                                          With several words each is one argument; @file is
                                          that file's JSON. A string starting with @: '"@user"'
  agent-bridge call --batch               Read \`tool args\` lines from stdin (args may be @file); one JSON line per call, one connection
  agent-bridge repl                       Interactive prompt (history, tab completion, .help). With
                                          stdin not a terminal it behaves like call --batch
  agent-bridge run <flow.mjs|.ts>         Run a flow: export default async ({ step, call }) => {}
                                          export const scenario = 'signedIn' applies it first
                                          and runs bridge.restore after, even on failure
  agent-bridge scenarios                  Scenarios the app defines (scenario.apply applies one)
  agent-bridge assert-absent <files...>   Fail if a release bundle contains the bridge

Sessions: one connection for all of an agent's calls
  agent-bridge session start [--name n] [--idle 15m]   Connect once in the background
  agent-bridge session stop [--name n] [--keep]        bridge.restore (unless --keep), then end
  agent-bridge session stop --dry-run                  List what bridge.restore would undo; keep running
  agent-bridge session list | status [--name n]
  call, tools, repl and run use this project's running session (the only one, or the one
  matching --metro/--device), and print its name. With several, pass --session <name>.

Options
  --metro <host:port>    Metro dev server (env AGENT_BRIDGE_METRO, default localhost:8081)
  --device <text>        Pick an app when several are connected
  --transport <name>     auto (default), expo or cdp
  --timeout <ms>         Per-call timeout (default 10000)
  --out <file>           call: write the result to a file; print its size and shape
                         (--batch: a directory, one <n>-<tool>.json per call)
  --stop-on-error        call --batch: stop after the first failed call
  --full                 call: print results over 32 KB instead of a summary
  --strict               run: exit non-zero if the app logged an error
  --scenario <name>      run: also apply this scenario (repeatable). Options as
                         JSON after "=": --scenario 'signedIn={"user":{"name":"Ada"}}'
  --session <name>       Use this session (env AGENT_BRIDGE_SESSION)
  --no-session           Connect directly even if a session is running
`

/** Errors a failed call brought back, for printing before the failure. */
const failedLogs = (error: unknown): LogEntry[] =>
  error instanceof AgentBridgeCallError ? error.logs : []

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  // `call --batch | head -1`: the reader left, so stop quietly. Not a stdout
  // 'error' listener: under bun that truncates large output.
  process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0)
    // Rethrowing here would exit 7, not the 1 a crash normally gives.
    console.error(error)
    process.exit(1)
  })
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      metro: { type: 'string' },
      device: { type: 'string' },
      transport: { type: 'string' },
      timeout: { type: 'string' },
      strict: { type: 'boolean' },
      out: { type: 'string' },
      full: { type: 'boolean' },
      batch: { type: 'boolean' },
      'stop-on-error': { type: 'boolean' },
      scenario: { type: 'string', multiple: true },
      name: { type: 'string' },
      idle: { type: 'string' },
      keep: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
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
    if (session)
      console.error(
        `Using session "${session.name}" (${session.device.name} on ${session.metro})`,
      )
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

  const batch = async (bridge: AgentBridge) => {
    const { failed } = await runBatch(bridge, process.stdin, {
      stopOnError: values['stop-on-error'],
      full: values.full,
      outDir: values.out,
    })
    if (failed) process.exitCode = 1
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
      if (values.batch) {
        if (rest.length)
          throw new Error('call --batch reads calls from stdin; pass no tool')
        return withBridge((bridge) => batch(bridge))
      }
      const [tool, ...words] = rest
      if (!tool) throw new Error('Usage: agent-bridge call <tool> [args]')
      if (words.filter((w) => w === '@-').length > 1)
        throw new Error('Only one argument can be @- (stdin)')
      // Parsed before connecting, so a bad file fails fast.
      const stdin = words.includes('@-') ? await readStdin() : ''
      const args = parseCallArgv(words, (path) =>
        path === '-' ? stdin : readArgFile(path),
      )
      return withBridge(async (bridge) => {
        const { value, ms, appMs, logs, notice } = await bridge
          .timed(tool, ...args)
          .catch((error: unknown) => {
            for (const e of failedLogs(error)) console.error(logLine(e))
            throw error
          })
        console.log(
          await renderResult(value, { out: values.out, full: values.full }),
        )
        for (const e of logs) console.error(logLine(e))
        if (notice) console.error(`Warning: ${notice}`)
        console.error(
          `${tool} via ${bridge.transport}: ${ms.toFixed(1)} ms round trip, ${appMs} ms in the app`,
        )
      })
    }
    case 'repl':
      if (values.out)
        throw new Error(
          'repl has no --out; use `call --batch --out <dir>` to write results to files',
        )
      return withBridge(async (bridge) => {
        if (!process.stdin.isTTY) return batch(bridge)
        // Prompt and colours only when someone is looking at the output.
        await runRepl(bridge, {
          input: process.stdin,
          output: process.stdout,
          tty: !!process.stdout.isTTY,
          historyFile: DEFAULT_HISTORY_FILE,
          full: values.full,
        })
      })
    case 'run': {
      const [file] = rest
      if (!file) throw new Error('Usage: agent-bridge run <flow file>')
      const flow = (await import(pathToFileURL(resolve(file)).href)) as FlowModule
      // Before connecting, so a bad declaration fails fast.
      flowScenarios(flow)
      const extra = (values.scenario ?? []).map(parseScenarioFlag)
      return withBridge(async (bridge) => {
        const { errors, restoreErrors } = await runFlow(bridge, flow, {
          scenarios: extra,
        })
        if ((values.strict && errors) || restoreErrors.length)
          process.exitCode = 1
      })
    }
    case 'scenarios':
      return withBridge(async (bridge) => {
        if (!bridge.tools().some((t) => t.name === 'scenario.list')) {
          console.log(
            `${bridge.device.name} defines no scenarios (pass \`scenarios\` to useAgentBridge).`,
          )
          return
        }
        const list = await bridge.call<
          Array<{ name: string; description?: string; options?: unknown; active: boolean }>
        >('scenario.list')
        console.log(`${bridge.device.name} via ${bridge.transport}`)
        for (const s of list) {
          console.log(
            `  ${s.name.padEnd(20)} ${s.active ? '(active) ' : ''}${s.description ?? ''}`,
          )
          if (s.options)
            console.log(`  ${''.padEnd(20)} options: ${JSON.stringify(s.options)}`)
        }
      })
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
