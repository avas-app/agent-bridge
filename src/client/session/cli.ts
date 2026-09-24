// The `agent-bridge session ...` commands and the hidden daemon entry point.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'

import type { ResultMessage } from '../../shared/protocol'
import type { TransportName } from '../connection'
import { metroHost } from '../discover'
import { sessionRequest } from './client'
import { runSessionDaemon } from './daemon'
import {
  type SessionState,
  checkName,
  formatDuration,
  isAlive,
  listSessions,
  parseDuration,
  pickSession,
  readSession,
  sessionFiles,
  writePrivate,
} from './state'

export const DAEMON_COMMAND = '__session-daemon'

export type SessionFlags = {
  metro?: string
  device?: string
  transport?: string
  timeout?: string
  name?: string
  idle?: string
  keep?: boolean
  session?: string
  'no-session'?: boolean
}

/** The session `call`, `tools` and `run` should go through, or null to connect directly. */
export function sessionFor(flags: SessionFlags): SessionState | null {
  if (flags['no-session']) return null
  return pickSession({
    name: flags.session ?? process.env.AGENT_BRIDGE_SESSION,
    metro: metroHost(flags.metro),
    device: flags.device,
    transport: flags.transport,
  })
}

const describeRestore = (restore: ResultMessage | null | undefined) => {
  if (!restore) return 'App state kept (--keep).'
  if (restore.ok) return `bridge.restore: ${JSON.stringify(restore.value)}`
  if (/Unknown tool/.test(restore.error))
    return 'The app has no bridge.restore; nothing was undone.'
  return `bridge.restore failed: ${restore.error}`
}

/** The one session a stop/status means: named, the only one, or the only match. */
function chosen(flags: SessionFlags): SessionState {
  const name = flags.name ?? flags.session ?? process.env.AGENT_BRIDGE_SESSION
  if (name) {
    const state = readSession(checkName(name))
    if (!state) throw new Error(`No session named "${name}" is running`)
    return state
  }
  const all = listSessions()
  if (all.length === 1) return all[0] as SessionState
  const match = sessionFor({ ...flags, session: undefined })
  if (match) return match
  throw new Error(
    all.length
      ? `Several sessions are running (${all.map((s) => s.name).join(', ')}); pass --name`
      : 'No session is running',
  )
}

function freeName(): string {
  const taken = new Set(listSessions().map((s) => s.name))
  let name = 'default'
  for (let n = 2; taken.has(name); n++) name = `default-${n}`
  return name
}

async function start(flags: SessionFlags) {
  const name = checkName(flags.name ?? freeName())
  const running = readSession(name)
  if (running)
    throw new Error(`Session "${name}" is already running (pid ${running.pid})`)
  const files = sessionFiles(name)
  rmSync(files.error, { force: true })

  const args = [
    DAEMON_COMMAND,
    '--name',
    name,
    '--metro',
    metroHost(flags.metro),
  ]
  args.push('--idle', String(parseDuration(flags.idle ?? '15m')))
  if (flags.device) args.push('--device', flags.device)
  if (flags.transport) args.push('--transport', flags.transport)
  if (flags.timeout) args.push('--timeout', flags.timeout)
  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1] as string, ...args],
    { detached: true, stdio: 'ignore', windowsHide: true },
  )

  // Ready when the daemon has written its state; failed when it wrote an error.
  const state = await new Promise<SessionState>((resolve, reject) => {
    const deadline = Date.now() + 30_000
    let exited = false
    child.once('exit', () => {
      exited = true
    })
    const tick = setInterval(() => {
      const ready = readSession(name)
      const failed = existsSync(files.error)
      if (ready && ready.pid === child.pid) {
        clearInterval(tick)
        resolve(ready)
      } else if (failed || exited || Date.now() > deadline) {
        clearInterval(tick)
        if (!exited) child.kill()
        const reason = failed
          ? readFileSync(files.error, 'utf8')
          : exited
            ? `The session exited early; see ${files.log}`
            : `The session didn't connect within 30 s; see ${files.log}`
        rmSync(files.error, { force: true })
        reject(new Error(reason))
      }
    }, 50)
  })
  child.unref()
  const idle = state.idleMs
    ? `, stops after ${formatDuration(state.idleMs)} idle`
    : ''
  console.log(
    `Session "${state.name}": ${state.device.name} via ${state.transport}${idle}`,
  )
  console.log(
    '`call`, `tools` and `run` go through it; `agent-bridge session stop` undoes and ends it.',
  )
}

async function stop(flags: SessionFlags) {
  const state = chosen(flags)
  const res = await sessionRequest(state, {
    op: 'stop',
    keep: !!flags.keep,
  }).catch(() => null)
  if (!res || res.error) {
    // The daemon isn't answering: SIGTERM runs the same teardown.
    if (isAlive(state.pid)) process.kill(state.pid, 'SIGTERM')
    console.log(`Session "${state.name}" didn't answer; sent it SIGTERM.`)
    return
  }
  console.log(
    `Stopped session "${state.name}". ${describeRestore(res.restore)}`,
  )
}

function list() {
  const sessions = listSessions()
  if (!sessions.length) console.log('No sessions.')
  for (const s of sessions) {
    const left = s.idleMs
      ? `${formatDuration(s.lastCallAt + s.idleMs - Date.now())} left`
      : 'no idle limit'
    console.log(
      `${s.name.padEnd(12)} ${s.device.name}  ${s.transport}  ${s.metro}  ${left}  pid ${s.pid}`,
    )
  }
}

async function status(flags: SessionFlags) {
  const state = chosen(flags)
  const res = await sessionRequest(state, { op: 'info' })
  if (res.error) throw new Error(res.error)
  console.log(
    JSON.stringify({ ...res.state, tools: res.device?.tools.length }, null, 2),
  )
}

export async function sessionCommand(
  sub: string | undefined,
  flags: SessionFlags,
) {
  switch (sub) {
    case 'start':
      return start(flags)
    case 'stop':
      return stop(flags)
    case 'list':
      return list()
    case 'status':
      return status(flags)
    default:
      throw new Error('Usage: agent-bridge session start|stop|list|status')
  }
}

/** The detached process `session start` spawns. Never writes to stdout/stderr. */
export async function daemonMain(flags: SessionFlags) {
  const name = checkName(flags.name ?? 'default')
  let daemon: Awaited<ReturnType<typeof runSessionDaemon>>
  try {
    daemon = await runSessionDaemon({
      name,
      metro: flags.metro,
      device: flags.device,
      transport: flags.transport as 'auto' | TransportName | undefined,
      idleMs: parseDuration(flags.idle ?? '15m'),
      timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
    })
  } catch (error) {
    writePrivate(
      sessionFiles(name).error,
      error instanceof Error ? error.message : String(error),
    )
    process.exit(1)
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(signal, () => void daemon.stop())
  await daemon.done
  process.exit(0)
}
