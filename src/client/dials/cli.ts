// `agent-bridge dials list|resume|clear|check|serve`
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import WebSocket from 'ws'

import type { AgentBridge } from '../index'
import { metroHost } from '../discover'
import { sessionRequest } from '../session/client'
import { startSession } from '../session/cli'
import { type SessionState, inProject, listSessions, projectRoot } from '../session/state'
import {
  type DialInfo,
  clearDials,
  dialsPath,
  agentWaiting,
  readCommit,
  cancelCommit,
  markWaiter,
  readDials,
  savedValues,
  takeCommit,
  updateCommit,
} from '../session/dials-store'
import type { CommitRequest } from '../session/dials-store'
import { createDialsServer, tailscaleAddress } from './server'

export type DialsFlags = {
  json?: boolean
  live?: boolean
  port?: string
  host?: string
  tailscale?: boolean
  timeout?: string
  message?: string
  'screenshot-cmd'?: string
  outline?: string
  'new-key'?: boolean
  'no-reload'?: boolean
  metro?: string
  device?: string
  idle?: string
  'no-session'?: boolean
}

type WithBridge = (fn: (bridge: AgentBridge) => Promise<void>) => Promise<void>

const SKIP = new Set(['node_modules', 'dist', 'build', '.agent-bridge', '.git'])
const SOURCE = /\.(?:[cm]?[jt]sx?)$/
const CALL = /\bdial\.(color|number|enum|boolean|text|token|variant)\(\s*(['"`])((?:(?!\2)[^\n])*)\2/g

export type DialCall = { file: string; line: number; type: string; id: string }

/** Every `dial.<type>("id", ...)` call under `root`. */
export function scanDialCalls(root: string): DialCall[] {
  const found: DialCall[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue
      const path = join(dir, entry)
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (stat.isDirectory()) walk(path)
      else if (SOURCE.test(entry) && !entry.endsWith('.d.ts')) {
        const text = readFileSync(path, 'utf8')
        for (const m of text.matchAll(CALL)) {
          const line = text.slice(0, m.index).split('\n').length
          found.push({ file: relative(root, path), line, type: m[1] as string, id: m[3] as string })
        }
      }
    }
  }
  walk(root)
  return found
}

const STATUSES = ['writing', 'done', 'failed', 'cancelled'] as const

function describeCommit(commit: CommitRequest): string {
  const lines = [`Commit requested (${commit.id}): ${commit.ids.length} dial(s)`]
  if (commit.note) lines.push(`Note: ${commit.note}`)
  for (const [id, v] of Object.entries(commit.values))
    lines.push(
      `  ${id}: ${JSON.stringify(v.original)} -> ${JSON.stringify(v.value)}${v.source ? `  (${v.source.file}:${v.source.line})` : ''}`,
    )
  if (commit.revertOthers) lines.push('Revert every other dial to its original.')
  lines.push('When you start editing run `agent-bridge dials commit-status writing`, then `done` or `failed --message <why>`.')
  return lines.join('\n')
}

/** App dials, or none when the app has no dial tools. */
async function appDials(bridge: AgentBridge): Promise<DialInfo[]> {
  if (!bridge.tools().some((t) => t.name === 'dial.list')) return []
  return bridge.call<DialInfo[]>('dial.list')
}

export async function dialsCommand(
  sub: string | undefined,
  rest: string[],
  flags: DialsFlags,
  withBridge: WithBridge,
  project = projectRoot(),
  start: typeof startSession = startSession,
): Promise<void> {
  switch (sub) {
    case 'list': {
      let app: DialInfo[] = []
      try {
        await withBridge(async (bridge) => {
          app = await appDials(bridge)
        })
      } catch (error) {
        console.error(`No app connected (${error instanceof Error ? error.message : String(error)}); showing saved dials only.`)
      }
      const saved = readDials(project)
      const rows = [
        ...app.map((d) => ({ ...d, saved: d.id in saved })),
        ...Object.entries(saved)
          .filter(([id]) => !app.some((d) => d.id === id))
          .map(([id, s]) => ({ id, type: s.type, value: s.value, original: s.original, saved: true })),
      ]
      if (flags.json) return void console.log(JSON.stringify(rows, null, 2))
      if (!rows.length) return void console.log('No dials.')
      for (const r of rows)
        console.log(
          `${r.id.padEnd(28)} ${r.type.padEnd(8)} ${JSON.stringify(r.value)}  (was ${JSON.stringify(r.original)})${r.saved ? '  saved' : ''}${app.some((d) => d.id === r.id) ? '' : '  not in app'}`,
        )
      const queued = readCommit(project)
      if (queued?.status === 'requested')
        console.log(
          `\nCommit ${queued.id.slice(0, 8)} is queued (${queued.ids.length} dial${queued.ids.length === 1 ? '' : 's'}${queued.note ? `, note: ${JSON.stringify(queued.note)}` : ''}); run \`agent-bridge dials wait --json\` to take it.`,
        )
      return
    }
    case 'resume': {
      const values = savedValues(readDials(project))
      if (!Object.keys(values).length) return void console.log(`Nothing saved in ${dialsPath(project)}.`)
      return withBridge(async (bridge) => {
        const out = await bridge.call<{ applied: string[]; unknown: string[] }>('dial.apply', values)
        console.log(`applied ${out.applied.length}, unknown ${out.unknown.length}${out.unknown.length ? `: ${out.unknown.join(', ')}` : ''}`)
      })
    }
    case 'clear': {
      const gone = clearDials(project, rest)
      console.log(gone.length ? `Cleared ${gone.join(', ')}.` : 'Nothing to clear.')
      return
    }
    case 'check': {
      const calls = scanDialCalls(project)
      if (flags.live) {
        const ids = new Set(calls.map((c) => c.id))
        let missing: string[] = []
        await withBridge(async (bridge) => {
          missing = (await appDials(bridge)).map((d) => d.id).filter((id) => !ids.has(id))
        })
        if (missing.length) {
          console.error(`Dials with no source call: ${missing.join(', ')}`)
          process.exitCode = 1
        } else console.log('Every app dial has a source call.')
        return
      }
      for (const c of calls) console.log(`${c.file}:${c.line}:${c.id}`)
      if (calls.length) {
        console.error(`${calls.length} dial call(s) left in source; unwrap them before committing.`)
        process.exitCode = 1
      } else console.log('No dial calls in source.')
      return
    }
    case 'serve': {
      if (flags.outline !== undefined && !flags.outline.trim()) throw new Error('--outline needs a colour, e.g. --outline "#FF3EA5"')
      const tail = flags.tailscale ? tailscaleAddress() : undefined
      const port = flags.port === undefined ? undefined : Number(flags.port)
      if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536))
        throw new Error(`--port must be 0-65535, got "${flags.port}"`)
      if (!agentBridgeIgnored(project))
        console.error('Warning: .agent-bridge/ is not git-ignored, so the panel key could be committed. Add `.agent-bridge/` to .gitignore.')
      const panel = createDialsServer({
        project,
        key: panelKey(project, !!flags['new-key']),
        host: tail?.ip ?? flags.host,
        port,
        screenshotCmd: flags['screenshot-cmd'],
        outline: flags.outline?.trim(),
      })
      const bound = await panel.listen()
      console.log(`http://${tail?.name ?? (bound.host === '0.0.0.0' ? 'localhost' : bound.host)}:${bound.port}/?key=${panel.key}`)
      console.error('Dials panel running; Ctrl-C to stop.')
      const stopped = new Promise<void>((resolve) => {
        for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, resolve)
      })
      // The panel reads the app through a session; start one if the project has none, and stop only that one.
      let own: SessionState | undefined
      if (!flags['no-session'] && !listSessions().some((s) => inProject(s.project, project))) {
        try {
          own = await start(
            { metro: flags.metro, device: flags.device, idle: flags.idle ?? '8h' },
            { cwd: project, base: 'dials' },
          )
          console.error(`Started session "${own.name}" (${own.device.name}); it stops when the panel does.`)
        } catch (error) {
          console.error(
            `Couldn't start a bridge session (${error instanceof Error ? error.message : String(error)}). The panel stays empty until \`agent-bridge session start\` runs in the project.`,
          )
        }
      }
      if (!agentWaiting(project))
        console.error('Run `agent-bridge dials wait --json` in the background to receive commits from the panel.')
      await stopped
      if (own) {
        // --keep: leave the app as the user tuned it.
        const res = await sessionRequest(own, { op: 'stop', keep: true }).catch(() => null)
        if (res && !res.error) console.error(`Stopped session "${own.name}".`)
      }
      await panel.close()
      return
    }
    case 'wait': {
      const seconds = flags.timeout === undefined ? undefined : Number(flags.timeout)
      if (seconds !== undefined && !(seconds >= 0)) throw new Error(`--timeout is in seconds, got "${flags.timeout}"`)
      const deadline = seconds === undefined ? Infinity : Date.now() + seconds * 1000
      const unmark = markWaiter(project)
      // A signal skips `finally`; unmark on the way out so the panel stops saying an agent listens.
      const onSignal = (sig: NodeJS.Signals) => {
        unmark()
        process.kill(process.pid, sig)
      }
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, onSignal)
      try {
        for (;;) {
          const taken = takeCommit(project)
          if (taken) {
            console.log(flags.json ? JSON.stringify(taken, null, 2) : describeCommit(taken))
            return
          }
          if (Date.now() >= deadline) {
            console.error('No commit requested before the timeout.')
            process.exitCode = 2
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      } finally {
        for (const sig of ['SIGINT', 'SIGTERM'] as const) process.off(sig, onSignal)
        unmark()
      }
    }
    case 'commit-status': {
      const status = rest[0]
      if (!status || !STATUSES.includes(status as (typeof STATUSES)[number]))
        throw new Error(`Usage: agent-bridge dials commit-status <${STATUSES.join('|')}> [<commit id>] [--message <text>] [--no-reload]`)
      const wanted = rest[1]
      const next = updateCommit(project, (commit) => {
        if (!commit) throw new Error('No commit request to update.')
        if (wanted && !commit.id.startsWith(wanted))
          throw new Error(`The current request is a different commit (${commit.id.slice(0, 8)}), not ${wanted}.`)
        if (commit.status === 'cancelled' && status !== 'cancelled')
          throw new Error(`Commit ${commit.id.slice(0, 8)} was cancelled; leave the files as they are.`)
        if (commit.status === 'requested' && status !== 'cancelled')
          throw new Error(`Commit ${commit.id.slice(0, 8)} has not been taken yet; run \`dials wait\` first.`)
        const { message: _old, ...kept } = commit
        return { ...kept, status: status as (typeof STATUSES)[number], ...(flags.message ? { message: flags.message } : {}) }
      })
      console.log(`commit ${next?.id.slice(0, 8)}: ${status}`)
      if (status === 'done' && !flags['no-reload']) {
        // Removing dial.* calls changes a component's hook count, which Fast Refresh can't follow.
        const metro = flags.metro ?? listSessions().find((s) => inProject(s.project, project))?.metro
        const host = metroHost(metro)
        if (await reloadApps(host)) console.log(`Reloaded the app through Metro (${host}).`)
        else console.error(`Couldn't reach Metro at ${host} to reload the app; reload it yourself (r in Metro).`)
      }
      return
    }
    case 'cancel': {
      const commit = cancelCommit(project)
      console.log(commit ? `commit ${commit.id.slice(0, 8)}: cancelled` : 'No commit in flight.')
      return
    }
    default:
      throw new Error('Usage: agent-bridge dials list [--json] | resume | clear [id...] | check [--live] | serve [--port N] [--tailscale] [--host H] [--screenshot-cmd <cmd>] [--outline <color>] [--new-key] [--metro H] [--device D] [--idle 8h] [--no-session] | wait [--timeout <s>] [--json] | commit-status <writing|done|failed|cancelled> [<commit id>] [--message <text>] [--no-reload] | cancel')
  }
}

/** Looks for an `.agent-bridge/` line in .gitignore files from the project up to the repo root. */
function agentBridgeIgnored(project: string): boolean {
  for (let dir = resolve(project); ; dir = dirname(dir)) {
    try {
      if (/^\/?\.agent-bridge\/?\s*$/m.test(readFileSync(join(dir, '.gitignore'), 'utf8'))) return true
    } catch {}
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return false
  }
}

/** The panel key kept in <project>/.agent-bridge/dials-key, so a restart keeps the link; `rotate` makes a new one. */
export function panelKey(project: string, rotate = false): string {
  const dir = join(project, '.agent-bridge')
  const file = join(dir, 'dials-key')
  if (!rotate) {
    try {
      const saved = readFileSync(file, 'utf8').trim()
      if (/^[0-9a-f]{32}$/.test(saved)) {
        if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600)
        return saved
      }
    } catch {}
  }
  const key = randomBytes(16).toString('hex')
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `dials-key.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(temp, `${key}\n`, { flag: 'wx', mode: 0o600 })
  renameSync(temp, file)
  return key
}

/** Asks Metro to reload every connected app, like pressing r in its terminal. */
export function reloadApps(metro: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${metro}/message`)
    const done = (ok: boolean) => {
      clearTimeout(timer)
      ws.removeAllListeners()
      ws.on('error', () => {})
      ws.terminate()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ version: 2, method: 'reload' }), (error) => done(!error)))
    ws.on('error', () => done(false))
  })
}
