import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { version } from '../../package.json'
import { type Detection, type ReadFs, detect } from './detect'
import { type Action, type InitOptions, type InitReport, bridgePath, plan } from './plan'
import { DOCS, NETWORK_PROMPT } from './render'
import { scan } from './scan'

const INSTALL_TIMEOUT_MS = 5 * 60_000
const SKILL_TIMEOUT_MS = 2 * 60_000
const posix = (p: string) => p.split(sep).join('/')

export type InitArgs = {
  dir?: string
  out?: string
  dryRun?: boolean
  force?: boolean
  install?: boolean
  skill?: boolean
  /** Undefined: ask in a terminal, otherwise leave it off and list the choice. */
  network?: boolean
  json?: boolean
  yes?: boolean
}

export type InitIo = {
  fs: ReadFs
  write: (path: string, content: string) => void
  append: (path: string, text: string) => void
  /** Runs a command; its output goes to stderr so `--json` stdout stays clean. */
  exec: (
    command: string[],
    cwd: string,
    interactive: boolean,
    timeoutMs: number,
  ) => Promise<number | 'timeout'>
  /** Asks a y/N question; only called when `interactive`. */
  prompt: (question: string) => Promise<string>
  print: (text: string) => void
  warn: (text: string) => void
  interactive: boolean
  cwd: string
  userAgent?: string
}

export const nodeFs: ReadFs = {
  exists: existsSync,
  read: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  },
  readJson: (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return undefined
    }
  },
  list: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name,
        dir: e.isDirectory(),
      }))
    } catch {
      return []
    }
  },
}

export function nodeIo(): InitIo {
  return {
    fs: nodeFs,
    write: (path, content) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    },
    append: (path, text) => appendFileSync(path, text),
    exec: (command, cwd, interactive, timeoutMs) =>
      new Promise((done) => {
        const [cmd, ...args] = command
        const child = spawn(cmd!, args, {
          cwd,
          stdio: [interactive ? 'inherit' : 'ignore', 2, 2],
          shell: process.platform === 'win32',
        })
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          done('timeout')
        }, timeoutMs)
        child.on('error', () => {
          clearTimeout(timer)
          done(127)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          done(code ?? 1)
        })
      }),
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        return await rl.question(question)
      } finally {
        rl.close()
      }
    },
    print: (text) => process.stdout.write(`${text}\n`),
    warn: (text) => process.stderr.write(`${text}\n`),
    interactive:
      !!process.stdin.isTTY && !!process.stdout.isTTY && !/^(1|true)$/i.test(process.env.CI ?? ''),
    cwd: process.cwd(),
    userAgent: process.env.npm_config_user_agent,
  }
}

/** Runs the actions in order; install and skill results go into the report. */
export async function apply(
  actions: Action[],
  report: InitReport,
  io: InitIo,
  interactive: boolean,
): Promise<void> {
  const why = (code: number | 'timeout', ms: number) =>
    code === 'timeout' ? `timed out after ${ms / 60_000} min` : `exit code ${code}`
  for (const a of actions) {
    switch (a.kind) {
      case 'install': {
        const code = await io.exec(a.command, a.cwd, false, INSTALL_TIMEOUT_MS)
        report.install.status = code === 0 ? 'installed' : 'failed'
        if (code !== 0) {
          report.ok = false
          report.install.error = why(code, INSTALL_TIMEOUT_MS)
          io.warn(`Install failed (${a.command.join(' ')}): ${report.install.error}`)
        }
        break
      }
      case 'skill': {
        const code = await io.exec(a.command, a.cwd, interactive, SKILL_TIMEOUT_MS)
        report.skill.status = code === 0 ? 'added' : 'failed'
        if (code !== 0) {
          report.skill.error = why(code, SKILL_TIMEOUT_MS)
          io.warn(`Adding the skill failed (${report.skill.error}); add it later with ${report.skill.command}`)
        }
        break
      }
      case 'write':
        io.write(a.path, a.content)
        break
      case 'patch': {
        const result = a.patch(io.fs.read(a.path) ?? '')
        if ('text' in result) io.write(a.path, result.text)
        break
      }
      case 'append': {
        const text = io.fs.read(a.path) ?? ''
        io.append(a.path, `${text.endsWith('\n') || !text ? '' : '\n'}${a.line}\n`)
        break
      }
    }
  }
}

const describe = (a: Action, dir: string): string => {
  const rel = (p: string) => relative(dir, p) || '.'
  switch (a.kind) {
    case 'install':
      return `install   ${a.command.join(' ')}`
    case 'skill':
      return `skill     ${a.command.join(' ')}  (in ${a.cwd})`
    case 'write':
      return `write     ${rel(a.path)}`
    case 'patch':
      return `patch     ${rel(a.path)}`
    case 'append':
      return `append    ${rel(a.path)}: ${a.line}`
  }
}

/** The report for people. */
export function formatReport(r: InitReport, actions: Action[]): string {
  const L: string[] = []
  const detected = r.app.detected.length ? ` (${r.app.detected.join(', ')})` : ''
  L.push(
    `agent-bridge init ${r.version}${r.dryRun ? ' --dry-run: nothing changed' : ''}`,
    `App "${r.app.name}"${detected}, ${r.app.packageManager}`,
    '',
  )
  if (r.dryRun) {
    L.push('Would run:', ...actions.map((a) => `  ${describe(a, r.app.dir)}`), '')
    for (const a of actions)
      if (a.kind === 'write')
        L.push(`--- ${relative(r.app.dir, a.path)}`, a.content.trimEnd(), '')
  }
  L.push('Files')
  for (const f of r.files)
    L.push(`  ${f.status.padEnd(9)} ${f.path}${f.note ? `: ${f.note}` : ''}`)
  L.push(
    '',
    `Install: ${r.install.status} (${r.install.command})`,
    `Skill:   ${r.skill.status} (${r.skill.command})`,
    '         In Claude Code, install it as a plugin instead:',
    ...r.skill.plugin.map((l) => `           ${l}`),
  )
  if (r.existing.length)
    L.push('', `Already uses the bridge: ${r.existing.join(', ')}`)
  if (r.missing.length)
    L.push('', `Detected but not wired in the bridge file: ${r.missing.join(', ')} (see ${DOCS}/adapters.md)`)
  if (r.commented.length) {
    L.push('', 'Left as comments in the bridge file:')
    for (const c of r.commented)
      L.push(`  ${c.adapter}${c.items.length ? `: ${c.items.join(', ')}` : ''}. Why: ${c.why}`)
  }
  if (r.todos.length) L.push('', 'TODO:', ...r.todos.map((t) => `  ${t}`))
  const n = r.choices.network
  L.push('')
  if (n.enabled) L.push('Network tools: on (net.*).')
  else {
    const how = [n.flag && `rerun with ${n.flag}`, n.lines && 'add these lines'].filter(Boolean).join(', or ')
    L.push(`Network tools: off. ${n.open ? 'Open choice: ' : ''}${n.why}. To wire them, ${how}:`)
    L.push(...(n.lines ?? []).map((l) => `  ${l}`))
  }
  if (n.note) L.push(n.note)
  L.push(
    '',
    r.mount.mounted
      ? `Mounted: yes (from ${r.mount.file}).`
      : `Mounted: no. ${r.mount.note}`,
  )
  if (!r.mount.mounted && !r.existing.length)
    L.push(...r.mount.snippet.split('\n').map((l) => `  ${l}`))
  L.push('', `First run${r.runFrom === '.' ? '' : ` (from ${r.runFrom})`}:`)
  r.next.forEach((s, i) =>
    L.push(`  ${i + 1}. ${s.step}${s.command ? `\n       ${s.command}` : ''}`),
  )
  L.push('', 'Prompt for your agent:', `  ${r.prompt}`)
  return L.join('\n')
}

/** `agent-bridge init`. Returns the exit code. */
export async function runInit(args: InitArgs, io: InitIo): Promise<number> {
  const dir = resolve(io.cwd, args.dir ?? '.')
  const fail = (error: { error: string }) => {
    if (args.json) io.print(JSON.stringify({ ok: false, ...error }, null, 2))
    else io.warn(error.error)
    return 1
  }
  let d = detect(dir, io.fs, { userAgent: io.userAgent })
  if ('error' in d) return fail(d)
  // Prompts only for a person at a terminal (not CI) who'll get a new bridge file.
  const interactive = io.interactive && !args.json && !args.yes
  const options = (network: InitOptions['network']): InitOptions => ({
    version,
    out: args.out === undefined ? undefined : resolve(io.cwd, args.out),
    force: args.force,
    install: args.install !== false,
    skill: args.skill !== false,
    network,
    skillYes: !interactive,
  })
  const planFor = (det: Detection, network: InitOptions['network'], install = true) =>
    plan(det, scan(dir, io.fs), io.fs, { ...options(network), install: install && args.install !== false }, io.cwd)

  let network = { enabled: args.network ?? false, chosen: args.network !== undefined }
  const first = planFor(d, network)
  if ('error' in first) return fail(first)
  if (args.dryRun) {
    const { actions, report } = first
    report.dryRun = true
    if (args.json) {
      const contents = Object.fromEntries(
        actions.flatMap((a) => (a.kind === 'write' ? [[relative(dir, a.path), a.content]] : [])),
      )
      io.print(JSON.stringify({ ...report, contents }, null, 2))
    } else io.print(formatReport(report, actions))
    return 0
  }

  const bridge = posix(relative(dir, bridgePath(d, options(network).out)))
  const writesBridge = first.report.files.some((f) => f.path === bridge && f.status === 'written')
  if (!network.chosen && interactive && writesBridge) {
    const answer = await io.prompt(`${NETWORK_PROMPT} [y/N] `)
    network = { enabled: /^y(es)?$/i.test(answer.trim()), chosen: true }
  }

  // Install first: the files that name the CLI's command need to see its bin.
  const install = first.actions.find((a) => a.kind === 'install')
  const installReport = first.report.install
  if (install) {
    await apply([install], first.report, io, interactive)
    const after = detect(dir, io.fs, { userAgent: io.userAgent })
    if (!('error' in after)) d = after
  }
  const p = planFor(d, network, false)
  if ('error' in p) return fail(p)
  const { actions, report } = p
  if (install) {
    report.install = installReport
    report.ok = first.report.ok
  }
  await apply(actions, report, io, interactive)
  io.print(args.json ? JSON.stringify(report, null, 2) : formatReport(report, actions))
  return report.ok ? 0 : 1
}
