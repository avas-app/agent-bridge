import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import { type Detection, type ReadFs, PACKAGE } from './detect'
import { binFallback, installCommand } from './package-manager'
import {
  DOCS,
  MMKV_WHY,
  NETWORK_WHY,
  type Patch,
  REALTIME_WHY,
  type RealtimeTodo,
  STORES_WHY,
  agentsLine,
  patchEslint,
  patchOxlint,
  patchPackageScripts,
  patchTsconfig,
  realtimeTodoText,
  renderBridgeFile,
  renderFlowsReadme,
  renderMountSnippet,
  renderSmokeFlow,
} from './render'
import type { ScanResult } from './scan'

export type InitOptions = {
  version: string
  /** Where to write the bridge file, relative to the app. */
  out?: string
  force?: boolean
  install: boolean
  skill: boolean
  /** Whether to wire networkTools, and whether the user chose (flag or prompt). */
  network: { enabled: boolean; chosen: boolean }
  /** Skip the skills CLI's own prompts. */
  skillYes?: boolean
}

export type Action =
  | { kind: 'write'; path: string; content: string }
  /** Recomputed from the file at apply time: install rewrites package.json first. */
  | { kind: 'patch'; path: string; patch: (text: string) => Patch }
  | { kind: 'append'; path: string; line: string }
  | { kind: 'install'; command: string[]; cwd: string }
  | { kind: 'skill'; command: string[]; cwd: string }

export type FileStatus = 'written' | 'skipped' | 'patched' | 'unchanged' | 'manual' | 'appended'

export type InitReport = {
  ok: true
  version: string
  dryRun: boolean
  app: { dir: string; name: string; packageManager: string; detected: string[] }
  files: Array<{ path: string; status: FileStatus; note?: string }>
  install: { status: 'present' | 'installed' | 'not-run' | 'failed'; command: string; error?: string }
  skill: { status: 'added' | 'not-run' | 'failed'; command: string; plugin: string[]; error?: string }
  mount: { file: string | null; mounted: boolean; snippet: string; note: string }
  choices: { network: { enabled: boolean; open: boolean; flag: string; why: string } }
  /** Wired as comments on purpose, with why. */
  commented: Array<{ adapter: string; items: string[]; why: string }>
  todos: string[]
  /** On a re-run: detected adapters the existing bridge file doesn't mention. */
  missing: string[]
  /** Run the commands from here (relative to the cwd). */
  runFrom: string
  next: Array<{ step: string; command?: string }>
  prompt: string
  /** Scenarios the bridge file defines. */
  scenarios: string[]
}

export const SKILL_COMMAND = ['npx', 'skills', 'add', 'avas-app/agent-bridge']
/** What runs: --yes so npx never stops to ask about fetching the skills CLI. */
const SKILL_RUN = ['npx', '--yes', 'skills', 'add', 'avas-app/agent-bridge']
export const PLUGIN_LINES = [
  '/plugin marketplace add avas-app/agent-bridge',
  '/plugin install agent-bridge@agent-bridge',
]

// What each library looks like in a bridge file, to report ones a re-run finds unwired.
const MARKERS: Array<[keyof Detection['has'], RegExp, string]> = [
  ['expo', /expoTransport/, 'expo'],
  ['expoRouter', /routerTools/, 'expo-router'],
  ['reactQuery', /queryTools/, '@tanstack/react-query'],
  ['webview', /webviewTools/, 'react-native-webview'],
  ['zustand', /storeTools/, 'zustand'],
  ['mmkv', /mmkvTools/, 'react-native-mmkv'],
  ['socketIo', /realtimeDevTools|socketIoTools|realtime/i, 'socket.io-client'],
  ['ably', /realtimeDevTools|ablyTools|realtime/i, 'ably'],
]

const posix = (p: string) => p.split(sep).join('/')

/** `../stores/auth` from one file to another, without the extension. */
export function importPath(fromFile: string, toFile: string): string {
  const rel = posix(relative(dirname(fromFile), toFile)).replace(/\.(tsx?|jsx?|mjs|cjs)$/, '')
  return rel.startsWith('.') ? rel : `./${rel}`
}

/** The command to run the CLI with, relative to the app dir. */
export function binFor(d: Detection): string {
  if (d.bin) {
    const rel = posix(relative(d.dir, d.bin))
    return rel.startsWith('.') ? rel : `./${rel}`
  }
  if (d.pm === 'npm' && d.root !== d.dir)
    return `${posix(relative(d.dir, d.root))}/node_modules/.bin/agent-bridge`
  return binFallback(d.pm)
}

/** The bridge file: `--out`, else src/dev/ or dev/, .tsx with TypeScript. */
export function bridgePath(d: Detection, out?: string): string {
  if (out) return isAbsolute(out) ? out : join(d.dir, out)
  return join(d.dir, d.srcDir ? 'src/dev' : 'dev', `agent-bridge.${d.typescript ? 'tsx' : 'js'}`)
}

/** The first-run steps, with the command the agent should use. */
export function nextSteps(
  bin: string,
  { mounted, offline }: { mounted: boolean; offline: boolean },
): Pick<InitReport, 'next' | 'prompt'> {
  const next: InitReport['next'] = []
  if (!mounted) next.push({ step: 'Mount it: paste the snippet above' })
  next.push(
    { step: 'Reload the app (press r in Metro)' },
    { step: 'Start a session', command: `${bin} session start` },
    { step: 'List the tools', command: `${bin} tools` },
    { step: "See what's on screen", command: `${bin} call screen.snapshot` },
  )
  if (offline)
    next.push({ step: 'Try a scenario', command: `${bin} call scenario.apply '"offline"'` })
  next.push({ step: 'Undo everything and disconnect', command: `${bin} session stop` })
  return {
    next,
    prompt: `This app has agent-bridge. Start a session with \`${bin} session start\`, see the screen with \`${bin} call screen.snapshot\`, and check changes through the bridge instead of tapping; stop the session when done.`,
  }
}

export type Plan = { actions: Action[]; report: InitReport } | { error: string }

/** What init will do and say. Pure: reads only through `fs`, changes nothing. */
export function plan(
  d: Detection,
  found: ScanResult,
  fs: ReadFs,
  o: InitOptions,
  cwd: string,
): Plan {
  const rel = (p: string) => posix(relative(d.dir, p))
  const out = bridgePath(d, o.out)
  if (/^(src\/)?app\//.test(rel(out)))
    return {
      error: `${rel(out)} is under app/, where expo-router treats every file as a route. Pick another --out.`,
    }
  const ts = /\.tsx?$/.test(out)
  const bin = binFor(d)
  const actions: Action[] = []
  const files: InitReport['files'] = []
  const commented: InitReport['commented'] = []
  const todos: string[] = []

  const imported = (list: Array<{ name: string; file: string }>) =>
    list.map((f) => ({ name: f.name, from: importPath(out, join(d.dir, f.file)) }))
  // Already wrapped where the client is created: wire it instead of a TODO.
  const realtimeTools = imported(found.realtimeTools)
  const realtime: RealtimeTodo[] = realtimeTools.length ? [] : [
    ...(d.has.socketIo
      ? found.socketIo.length
        ? found.socketIo.map((f) => ({ kind: 'socket.io' as const, ...f }))
        : [{ kind: 'socket.io' as const }]
      : []),
    ...(d.has.ably
      ? found.ably.length
        ? found.ably.map((f) => ({ kind: 'ably' as const, ...f }))
        : [{ kind: 'ably' as const }]
      : []),
  ]

  const existing = fs.read(out)
  const keep = existing !== undefined && !o.force
  const network = keep ? existing.includes('networkTools(') : o.network.enabled
  const offline = keep ? /\boffline\s*:/.test(existing) : network

  if (keep) {
    files.push({ path: rel(out), status: 'skipped', note: 'exists; --force overwrites it' })
  } else {
    actions.push({
      kind: 'write',
      path: out,
      content: renderBridgeFile({
        version: o.version,
        appName: d.appName,
        ts,
        expo: d.has.expo,
        expoRouter: d.has.expoRouter,
        reactQuery: d.has.reactQuery,
        webview: d.has.webview,
        network,
        reactNavigation: d.has.reactNavigation && !d.has.expoRouter,
        stores: d.has.zustand ? imported(found.stores) : undefined,
        mmkv: d.has.mmkv ? imported(found.mmkv) : undefined,
        realtime,
        realtimeTools,
      }),
    })
    files.push({ path: rel(out), status: 'written' })
    if (d.has.zustand)
      commented.push({
        adapter: 'zustand',
        items: found.stores.map((s) => `${s.name} (${s.file})`),
        why: `${STORES_WHY} (${DOCS}/adapters.md)`,
      })
    if (d.has.mmkv)
      commented.push({
        adapter: 'react-native-mmkv',
        items: found.mmkv.map((s) => `${s.name} (${s.file})`),
        why: `${MMKV_WHY} (${DOCS}/adapters.md)`,
      })
    if (d.has.reactNavigation && !d.has.expoRouter)
      commented.push({
        adapter: '@react-navigation/native',
        items: ['nav.navigate', 'nav.current'],
        why: 'there is no React Navigation adapter; the sample tools need your container ref',
      })
    for (const t of realtime) todos.push(`${realtimeTodoText(t)}: ${REALTIME_WHY} (${DOCS}/realtime.md).`)
  }
  const missing = keep
    ? MARKERS.filter(([lib, marker]) => d.has[lib] && !marker.test(existing)).map(
        ([, , dep]) => dep,
      )
    : []

  const flows = join(d.dir, 'flows')
  const smoke = join(flows, 'smoke.flow.mjs')
  if (fs.exists(smoke) && !o.force) {
    files.push({ path: rel(smoke), status: 'skipped', note: 'exists' })
  } else {
    actions.push({
      kind: 'write',
      path: smoke,
      content: renderSmokeFlow({ version: o.version, expoRouter: d.has.expoRouter, bin }),
    })
    files.push({ path: rel(smoke), status: 'written' })
  }
  const readme = join(flows, 'README.md')
  if (fs.exists(readme)) files.push({ path: rel(readme), status: 'skipped', note: 'exists' })
  else {
    actions.push({ kind: 'write', path: readme, content: renderFlowsReadme(bin) })
    files.push({ path: rel(readme), status: 'written' })
  }

  const patch = (path: string | undefined, fn: (text: string) => Patch) => {
    if (!path) return
    const abs = join(d.dir, path)
    const result = fn(fs.read(abs) ?? '')
    if ('text' in result) {
      actions.push({ kind: 'patch', path: abs, patch: fn })
      files.push({ path, status: 'patched' })
    } else if ('manual' in result) {
      files.push({ path, status: 'manual', note: result.manual })
    } else {
      files.push({ path, status: 'unchanged' })
    }
  }
  patch('package.json', patchPackageScripts)
  patch(d.tsconfig, patchTsconfig)
  patch(d.oxlint, patchOxlint)
  patch(d.eslint, patchEslint)
  if (d.agentsFile) {
    const text = fs.read(d.agentsFile) ?? ''
    const path = posix(relative(d.dir, d.agentsFile))
    if (text.includes('.flow.mjs')) files.push({ path, status: 'unchanged' })
    else {
      const flowsFromThere = posix(relative(dirname(d.agentsFile), flows)) || 'flows'
      actions.push({ kind: 'append', path: d.agentsFile, line: agentsLine(flowsFromThere, bin) })
      files.push({ path, status: 'appended' })
    }
  }

  const spec = `${PACKAGE}@^${o.version}`
  const install = installCommand(d.pm, spec)
  if (!d.installed && o.install) actions.unshift({ kind: 'install', command: install, cwd: d.dir })
  const skill = o.skillYes ? [...SKILL_RUN, '-y'] : SKILL_RUN
  if (o.skill) actions.push({ kind: 'skill', command: skill, cwd: d.repoRoot })

  const rootFile = d.rootFile ? join(d.dir, d.rootFile) : undefined
  const rootText = rootFile ? (fs.read(rootFile) ?? '') : ''
  const mounted = /(from\s+|require\(\s*|import\s+)['"][^'"]*agent-bridge['"]/.test(rootText)
  const snippet = renderMountSnippet(importPath(rootFile ?? join(d.dir, 'App.tsx'), out))
  const where = d.rootFile
    ? `Paste the import into ${d.rootFile} and the element into the root component's JSX`
    : `No root component found (looked for ${d.has.expoRouter ? 'app/_layout or src/app/_layout' : 'App or src/App'}): paste it into yours, fixing the import path`
  const note = `${where}${d.has.reactQuery ? ', inside QueryClientProvider so query.* tools work' : ''}.`

  const detected = MARKERS.filter(([lib]) => d.has[lib]).map(([, , dep]) => dep)
  if (d.has.reactNavigation && !d.has.expoRouter) detected.push('@react-navigation/native')

  return {
    actions,
    report: {
      ok: true,
      version: o.version,
      dryRun: false,
      app: { dir: d.dir, name: d.appName, packageManager: d.pm, detected },
      files,
      install: {
        status: d.installed ? 'present' : 'not-run',
        command: install.join(' '),
      },
      skill: { status: 'not-run', command: SKILL_COMMAND.join(' '), plugin: PLUGIN_LINES },
      mount: { file: d.rootFile ?? null, mounted, snippet, note },
      choices: {
        network: {
          enabled: network,
          open: !network && !(o.network.chosen && !keep),
          // --force because the bridge file exists after any run but a dry one.
          flag: network ? '--no-network --force' : '--network --force',
          why: NETWORK_WHY,
        },
      },
      commented,
      todos,
      missing,
      runFrom: posix(relative(cwd, d.dir)) || '.',
      scenarios: offline ? ['offline'] : [],
      ...nextSteps(bin, { mounted, offline }),
    },
  }
}
