import type { ConnectOptions } from '../client/index'
import { connect } from '../client/index'
import { sessionFor, type SessionFlags } from '../client/session/cli'
import { connectSession } from '../client/session/client'
import { runSessionDaemon, type SessionDaemon } from '../client/session/daemon'
import { startMcpServer } from './server'

/**
 * `agent-bridge mcp`: serves the app's tools on stdin/stdout. Calls go through
 * the project's running session, or one this process starts and stops with it
 * (bridge.restore runs on exit unless --keep). stdout is the protocol; notes go to stderr.
 */
export async function mcpMain(
  flags: SessionFlags,
  options: ConnectOptions,
  version?: string,
) {
  let daemon: SessionDaemon | undefined
  const connectBridge = async () => {
    if (flags['no-session']) return connect(options)
    const existing = sessionFor(flags)
    if (existing)
      return connectSession({ name: existing.name, timeoutMs: options.timeoutMs })
    daemon ??= await runSessionDaemon({
      name: `mcp-${process.pid}`,
      metro: options.metro,
      device: options.device,
      transport: options.transport,
      idleMs: 0,
      timeoutMs: options.timeoutMs,
    })
    return connectSession({ name: daemon.state.name, timeoutMs: options.timeoutMs })
  }

  const server = startMcpServer({
    input: process.stdin,
    output: process.stdout,
    connect: connectBridge,
    pollMs: flags['no-session'] ? 0 : undefined,
    version,
  })
  const quit = () => server.close()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(signal, quit)
  await server.done
  const restore = await daemon?.stop(flags.keep).catch(() => null)
  if (restore && !restore.ok) console.error(`bridge.restore failed: ${restore.error}`)
}
