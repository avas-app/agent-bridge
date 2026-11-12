import type { ConnectOptions } from '../client/index'
import { connect } from '../client/index'
import { sessionFor, type SessionFlags } from '../client/session/cli'
import { connectSession } from '../client/session/client'
import { runSessionDaemon, type SessionDaemon } from '../client/session/daemon'
import { readSession } from '../client/session/state'
import { startMcpServer } from './server'

/**
 * How `agent-bridge mcp` reaches the app: the project's running session (pinned
 * by name once attached), or one this process starts and stops with it. It never
 * attaches to another server's `mcp-*` session.
 */
export function createConnector(flags: SessionFlags, options: ConnectOptions) {
  let daemon: SessionDaemon | undefined
  let pinned: string | undefined
  let ending = false
  let notice: string | undefined
  const ownName = `mcp-${process.pid}`

  const stopped = (name: string) => {
    notice = `The session "${name}" this server was using stopped (session stop, or its idle time ran out). Stopping runs bridge.restore, so state changed through it was most likely undone. This call did not run; call again and the server uses a new session.`
  }

  const connectBridge = async () => {
    if (flags['no-session']) return connect(options)
    const timeoutMs = options.timeoutMs
    if (daemon) return connectSession({ name: daemon.state.name, timeoutMs })
    if (pinned) {
      if (readSession(pinned)) return connectSession({ name: pinned, timeoutMs })
      stopped(pinned)
      pinned = undefined
    }
    const existing = sessionFor(flags, (s) => s.name.startsWith('mcp-') && s.name !== ownName)
    if (existing) {
      pinned = existing.name
      return connectSession({ name: pinned, timeoutMs })
    }
    const started = await runSessionDaemon({
      name: ownName,
      metro: options.metro,
      device: options.device,
      transport: options.transport,
      idleMs: 0,
      timeoutMs,
    })
    daemon = started
    void started.done.then(() => {
      if (daemon !== started) return
      daemon = undefined
      if (!ending) stopped(started.state.name)
    })
    return connectSession({ name: started.state.name, timeoutMs })
  }

  return {
    connect: connectBridge,
    takeNotice: () => {
      const n = notice
      notice = undefined
      return n
    },
    stop: async () => {
      ending = true
      return daemon?.stop(flags.keep).catch(() => null)
    },
    sessionName: () => daemon?.state.name ?? pinned,
  }
}

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
  const connector = createConnector(flags, options)
  const server = startMcpServer({
    input: process.stdin,
    output: process.stdout,
    connect: connector.connect,
    takeNotice: connector.takeNotice,
    sessionName: connector.sessionName,
    log: (line) => console.error(line),
    pollMs: flags['no-session'] ? 0 : undefined,
    version,
  })
  const quit = () => server.close()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(signal, quit)
  await server.done
  const restore = await connector.stop()
  if (restore && !restore.ok) console.error(`bridge.restore failed: ${restore.error}`)
}
