import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { version } from '../../package.json'
import { type ReadFs, detect } from './detect'
import {
  type Action,
  type InitReport,
  binFor,
  bridgePath,
  nextSteps,
  plan,
} from './plan'
import { NETWORK_PROMPT } from './render'
import { scan } from './scan'

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
  exec: (command: string[], cwd: string, interactive: boolean) => Promise<number>
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
    exec: (command, cwd, interactive) =>
      new Promise((done) => {
        const [cmd, ...args] = command
        const child = spawn(cmd!, args, {
          cwd,
          stdio: [interactive ? 'inherit' : 'ignore', 2, 2],
          shell: process.platform === 'win32',
        })
        child.on('error', () => done(127))
        child.on('close', (code) => done(code ?? 1))
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
    interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
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
  for (const a of actions) {
    switch (a.kind) {
      case 'install': {
        const code = await io.exec(a.command, a.cwd, false)
        report.install.status = code === 0 ? 'installed' : 'failed'
        if (code) {
          report.install.error = `exit code ${code}`
          io.warn(`Install failed (${a.command.join(' ')}): exit code ${code}`)
        }
        break
      }
      case 'skill': {
        const code = await io.exec(a.command, a.cwd, interactive)
        report.skill.status = code === 0 ? 'added' : 'failed'
        if (code) {
          report.skill.error = `exit code ${code}`
          io.warn(`Adding the skill failed (exit code ${code}); add it later with ${report.skill.command}`)
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
    `         In Claude Code instead: ${r.skill.plugin.join(' then ')}`,
  )
  if (r.missing.length)
    L.push('', `Detected but not in the bridge file: ${r.missing.join(', ')} (--force regenerates it)`)
  if (r.commented.length) {
    L.push('', 'Left as comments in the bridge file:')
    for (const c of r.commented)
      L.push(`  ${c.adapter}${c.items.length ? `: ${c.items.join(', ')}` : ''}. Why: ${c.why}`)
  }
  if (r.todos.length) L.push('', 'TODO:', ...r.todos.map((t) => `  ${t}`))
  const n = r.choices.network
  L.push(
    '',
    n.enabled
      ? 'Network tools: on (net.*, and the offline scenario).'
      : `Network tools: off. ${n.open ? 'Open choice: ' : ''}${n.why}. Rerun with ${n.flag} to wire them.`,
  )
  L.push(
    '',
    r.mount.mounted
      ? `Mounted: yes (${r.mount.file} imports agent-bridge).`
      : `Mounted: no. ${r.mount.note}`,
  )
  if (!r.mount.mounted) L.push(...r.mount.snippet.split('\n').map((l) => `  ${l}`))
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
  const d = detect(dir, io.fs, { userAgent: io.userAgent })
  if ('error' in d) {
    if (args.json) io.print(JSON.stringify({ ok: false, ...d }, null, 2))
    else io.warn(d.error)
    return 1
  }
  // Prompts only for a person at a terminal who'll get a new bridge file.
  const interactive = io.interactive && !args.json && !args.yes
  let network = { enabled: args.network ?? false, chosen: args.network !== undefined }
  const fresh = args.force || !io.fs.exists(bridgePath(d, args.out))
  if (!network.chosen && interactive && fresh && !args.dryRun) {
    const answer = await io.prompt(`${NETWORK_PROMPT} [y/N] `)
    network = { enabled: /^y(es)?$/i.test(answer.trim()), chosen: true }
  }

  const p = plan(
    d,
    scan(dir, io.fs),
    io.fs,
    {
      version,
      out: args.out,
      force: args.force,
      install: args.install !== false,
      skill: args.skill !== false,
      network,
      skillYes: !interactive,
    },
    io.cwd,
  )
  if ('error' in p) {
    if (args.json) io.print(JSON.stringify({ ok: false, error: p.error }, null, 2))
    else io.warn(p.error)
    return 1
  }
  const { actions, report } = p
  if (args.dryRun) {
    report.dryRun = true
    if (args.json) {
      const contents = Object.fromEntries(
        actions.flatMap((a) =>
          a.kind === 'write' ? [[relative(dir, a.path), a.content]] : [],
        ),
      )
      io.print(JSON.stringify({ ...report, contents }, null, 2))
    } else io.print(formatReport(report, actions))
    return 0
  }

  await apply(actions, report, io, interactive)
  // An install may have just created the bin the steps should use.
  const after = detect(dir, io.fs, { userAgent: io.userAgent })
  if (!('error' in after))
    Object.assign(
      report,
      nextSteps(binFor(after), {
        mounted: report.mount.mounted,
        offline: report.scenarios.includes('offline'),
      }),
    )
  io.print(args.json ? JSON.stringify(report, null, 2) : formatReport(report, actions))
  return report.install.status === 'failed' ? 1 : 0
}
