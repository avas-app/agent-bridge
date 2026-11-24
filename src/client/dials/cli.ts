// `agent-bridge dials list|resume|clear|check|serve`
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { AgentBridge } from '../index'
import { projectRoot } from '../session/state'
import {
  type DialInfo,
  clearDials,
  dialsPath,
  readCommit,
  readDials,
  savedValues,
  writeCommit,
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
  'new-key'?: boolean
}

type WithBridge = (fn: (bridge: AgentBridge) => Promise<void>) => Promise<void>

const SKIP = new Set(['node_modules', 'dist', 'build', '.agent-bridge', '.git'])
const SOURCE = /\.(?:[cm]?[jt]sx?)$/
const CALL = /\bdial\.(color|number|enum|boolean|text|token|variant)\(\s*(['"`])((?:(?!\2).)*)\2/g

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
        const lines = readFileSync(path, 'utf8').split('\n')
        lines.forEach((text, i) => {
          for (const m of text.matchAll(CALL))
            found.push({ file: relative(root, path), line: i + 1, type: m[1] as string, id: m[3] as string })
        })
      }
    }
  }
  walk(root)
  return found
}

const STATUSES = ['writing', 'done', 'failed'] as const

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
      const tail = flags.tailscale ? tailscaleAddress() : undefined
      const port = flags.port === undefined ? undefined : Number(flags.port)
      if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536))
        throw new Error(`--port must be 0-65535, got "${flags.port}"`)
      const panel = createDialsServer({
        project,
        key: panelKey(project, !!flags['new-key']),
        host: tail?.ip ?? flags.host,
        port,
        screenshotCmd: flags['screenshot-cmd'],
      })
      const bound = await panel.listen()
      console.log(`http://${tail?.name ?? (bound.host === '0.0.0.0' ? 'localhost' : bound.host)}:${bound.port}/?key=${panel.key}`)
      console.error('Dials panel running; Ctrl-C to stop.')
      await new Promise<void>((resolve) => {
        for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, resolve)
      })
      await panel.close()
      return
    }
    case 'wait': {
      const seconds = flags.timeout === undefined ? undefined : Number(flags.timeout)
      if (seconds !== undefined && !(seconds >= 0)) throw new Error(`--timeout is in seconds, got "${flags.timeout}"`)
      const deadline = seconds === undefined ? Infinity : Date.now() + seconds * 1000
      for (;;) {
        const commit = readCommit(project)
        if (commit?.status === 'requested') {
          const taken = { ...commit, status: 'taken' as const }
          writeCommit(project, taken)
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
    }
    case 'commit-status': {
      const status = rest[0]
      if (!status || !STATUSES.includes(status as (typeof STATUSES)[number]))
        throw new Error(`Usage: agent-bridge dials commit-status <${STATUSES.join('|')}> [--message <text>]`)
      const commit = readCommit(project)
      if (!commit) throw new Error('No commit request to update.')
      const { message: _old, ...rest2 } = commit
      writeCommit(project, {
        ...rest2,
        status: status as (typeof STATUSES)[number],
        ...(flags.message ? { message: flags.message } : {}),
      })
      console.log(`commit ${commit.id.slice(0, 8)}: ${status}`)
      return
    }
    default:
      throw new Error('Usage: agent-bridge dials list [--json] | resume | clear [id...] | check [--live] | serve [--port N] [--tailscale] [--host H] [--screenshot-cmd <cmd>] [--new-key] | wait [--timeout <s>] [--json] | commit-status <writing|done|failed> [--message <text>]')
  }
}

/** The panel key kept in <project>/.agent-bridge/dials-key, so a restart keeps the link; `rotate` makes a new one. */
export function panelKey(project: string, rotate = false): string {
  const file = join(project, '.agent-bridge', 'dials-key')
  if (!rotate) {
    try {
      const saved = readFileSync(file, 'utf8').trim()
      if (/^[0-9a-f]{32}$/.test(saved)) return saved
    } catch {}
  }
  const key = randomBytes(16).toString('hex')
  mkdirSync(join(project, '.agent-bridge'), { recursive: true })
  writeFileSync(file, `${key}\n`, { mode: 0o600 })
  return key
}
