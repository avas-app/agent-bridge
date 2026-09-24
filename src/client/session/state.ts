import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import type { TransportName } from '../connection'

/** What a running session writes next to its socket. Readable only by the user. */
export type SessionState = {
  name: string
  pid: number
  socket: string
  metro: string
  device: { name: string; deviceId: string; platform: string }
  /** The --device filter the session was started with, reused to reconnect. */
  deviceFilter?: string
  transport: TransportName
  startedAt: number
  lastCallAt: number
  /** 0 means no idle timeout. */
  idleMs: number
}

const uid = () => process.getuid?.() ?? userInfo().username

/** Creates `dir` 0700, or checks an existing one is a directory this user owns. */
function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (!stat.isDirectory())
    throw new Error(`${dir} is not a directory; remove it and retry`)
  if (process.getuid && stat.uid !== process.getuid())
    throw new Error(`${dir} belongs to another user; refusing to use it`)
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    chmodSync(dir, 0o700)
  return dir
}

/**
 * $AGENT_BRIDGE_STATE_DIR, else $XDG_RUNTIME_DIR/agent-bridge, else
 * <tmp>/agent-bridge-<uid>. Created 0700; refused if another user owns it.
 */
export function stateDir(): string {
  return privateDir(
    process.env.AGENT_BRIDGE_STATE_DIR ??
      (process.env.XDG_RUNTIME_DIR
        ? join(process.env.XDG_RUNTIME_DIR, 'agent-bridge')
        : join(tmpdir(), `agent-bridge-${uid()}`)),
  )
}

const shortHash = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16)

/**
 * Unix socket paths are capped near 104 bytes and macOS's $TMPDIR is long, so
 * a long path moves to a short private directory under /tmp.
 */
function socketPath(name: string, dir: string): string {
  if (process.platform === 'win32')
    return `\\\\.\\pipe\\agent-bridge-${shortHash(dir)}-${name}`
  const path = join(dir, `${name}.sock`)
  if (Buffer.byteLength(path) <= 100) return path
  const short = privateDir(`/tmp/agent-bridge-${uid()}`)
  return join(short, `${shortHash(path)}.sock`)
}

export const sessionFiles = (name: string, dir = stateDir()) => ({
  state: join(dir, `${name}.json`),
  error: join(dir, `${name}.error`),
  log: join(dir, `${name}.log`),
  socket: socketPath(name, dir),
})

export function checkName(name: string): string {
  if (!/^[\w.-]{1,40}$/.test(name))
    throw new Error(
      `Session name "${name}" must be 1-40 letters, digits, ".", "_" or "-"`,
    )
  return name
}

/** "15m", "30s", "1h", "500ms" or plain milliseconds. "0" turns it off. */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(text.trim())
  if (!match) throw new Error(`Can't read duration "${text}"; try 15m or 90s`)
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 }
  return Math.round(Number(match[1]) * (units[match[2] ?? 'ms'] ?? 1))
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600)
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function writePrivate(file: string, text: string) {
  writeFileSync(file, text, { mode: 0o600 })
}

export function removeSessionFiles(name: string, dir = stateDir()) {
  const files = sessionFiles(name, dir)
  rmSync(files.state, { force: true })
  if (process.platform !== 'win32') rmSync(files.socket, { force: true })
}

function readState(file: string): SessionState | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SessionState
  } catch {
    return null
  }
}

/** Live sessions. State left by a daemon that died is removed on the way. */
export function listSessions(dir = stateDir()): SessionState[] {
  const live: SessionState[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    const state = readState(join(dir, entry))
    if (!state) continue
    if (isAlive(state.pid)) live.push(state)
    else removeSessionFiles(state.name, dir)
  }
  return live.sort((a, b) => a.startedAt - b.startedAt)
}

export function readSession(name: string, dir = stateDir()) {
  return listSessions(dir).find((s) => s.name === name) ?? null
}

/**
 * The session a command should use: the one named, or the only live one on
 * this Metro that matches the device filter (and transport, if forced).
 * Returns null when none or several match.
 */
export function pickSession(filter: {
  name?: string
  metro: string
  device?: string
  transport?: string
}): SessionState | null {
  if (filter.name) {
    const named = readSession(checkName(filter.name))
    if (!named) throw new Error(`No session named "${filter.name}" is running`)
    return named
  }
  const device = filter.device?.toLowerCase()
  const matching = listSessions().filter(
    (s) =>
      s.metro === filter.metro &&
      (!device ||
        s.device.name.toLowerCase().includes(device) ||
        s.device.deviceId.toLowerCase().includes(device)) &&
      (!filter.transport ||
        filter.transport === 'auto' ||
        filter.transport === s.transport),
  )
  return matching.length === 1 ? (matching[0] as SessionState) : null
}
