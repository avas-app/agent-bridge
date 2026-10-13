import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import { type Detection, type ReadFs, PACKAGE } from './detect'
import { parseJsonc } from './jsonc'
import { binFallback, installCommand } from './package-manager'
import {
  DOCS,
  MMKV_WHY,
  NETWORK_WHY,
  type Patch,
  REALTIME_WHY,
  type RealtimeTodo,
  STORES_WHY,
  NETWORK_LINES,
  agentsLine,
  isPristine,
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
  /** Where to write the bridge file: absolute, or relative to the app. */
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
  /** False when the install failed. */
  ok: boolean
  version: string
  dryRun: boolean
  app: { dir: string; name: string; packageManager: string; detected: string[] }
  files: Array<{ path: string; status: FileStatus; note?: string }>
  install: { status: 'present' | 'installed' | 'not-run' | 'failed'; command: string; error?: string }
  skill: { status: 'added' | 'not-run' | 'failed'; command: string; plugin: string[]; error?: string }
  mount: { file: string | null; mounted: boolean; snippet: string; note: string }
  choices: {
    network: {
      enabled: boolean
      /** Nobody chose yet: ask the user. */
      open: boolean
      why: string
      /** Rerun with this to change it; only while the bridge file is init's own, unedited. */
      flag?: string
      /** Or add these by hand. */
      lines?: string[]
      /** Why a --network or --no-network flag had no effect. */
      note?: string
    }
  }
  /** Wired as comments on purpose, with why. */
  commented: Array<{ adapter: string; items: string[]; why: string }>
  todos: string[]
  /** On a re-run: detected adapters the existing bridge file doesn't mention. */
  missing: string[]
  /** Files that already call useAgentBridge or import the package. */
  existing: string[]
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
  o: { mounted: boolean; offline: boolean; runFrom: string; elsewhere?: boolean },
): Pick<InitReport, 'next' | 'prompt'> {
  const { offline, runFrom } = o
  const next: InitReport['next'] = []
  if (!o.mounted)
    next.push({
      step: o.elsewhere
        ? 'Make sure the root component renders the component that calls useAgentBridge'
        : 'Mount it: paste the snippet above',
    })
  next.push(
    { step: 'Reload the app (press r in Metro)' },
    { step: 'Start a session', command: `${bin} session start` },
    { step: 'List the tools', command: `${bin} tools` },
    { step: "See what's on screen", command: `${bin} call screen.snapshot` },
  )
  if (offline)
    next.push({ step: 'Try a scenario', command: `${bin} call scenario.apply '"offline"'` })
  next.push({ step: 'Undo everything and disconnect', command: `${bin} session stop` })
  const from = runFrom === '.' ? '' : `From \`${runFrom}\`: `
  return {
    next,
    prompt: `This app has agent-bridge. ${from ? `${from}s` : 'S'}tart a session with \`${bin} session start\`, see the screen with \`${bin} call screen.snapshot\`, and check changes through the bridge instead of tapping; stop the session when done.`,
  }
}

const stripExt = (p: string) => p.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '').replace(/\/index$/, '')

type Tsconfig = {
  // oxlint-disable-next-line no-explicit-any -- arbitrary JSON config
  json?: any
  /** allowJs from the configs it extends; undefined when unknown. */
  baseAllowJs?: boolean
  /** `paths` aliases, resolved to absolute prefixes. */
  aliases: Array<[string, string]>
}

function readTsconfig(d: Detection, fs: ReadFs): Tsconfig {
  if (!d.tsconfig) return { aliases: [] }
  const file = join(d.dir, d.tsconfig)
  // oxlint-disable-next-line no-explicit-any -- arbitrary JSON config
  const json = parseJsonc(fs.read(file) ?? '') as any
  if (!json) return { aliases: [] }
  const findExtended = (from: string, ext: string) => {
    const names = ext.endsWith('.json') ? [ext] : [ext, `${ext}.json`]
    const roots = ext.startsWith('.') ? [dirname(from)] : ancestors(dirname(from), d.repoRoot).map((a) => join(a, 'node_modules'))
    for (const r of roots) for (const n of names) if (fs.exists(join(r, n)) && !fs.list(join(r, n)).length) return join(r, n)
    return undefined
  }
  let baseAllowJs: boolean | undefined
  let ext = json.extends
  let from = file
  for (let depth = 0; typeof ext === 'string' && depth < 4; depth++) {
    const path = findExtended(from, ext)
    // oxlint-disable-next-line no-explicit-any -- arbitrary JSON config
    const base = path ? (parseJsonc(fs.read(path) ?? '') as any) : undefined
    if (!base) break
    if (typeof base.compilerOptions?.allowJs === 'boolean') {
      baseAllowJs = base.compilerOptions.allowJs
      break
    }
    ext = base.extends
    from = path!
  }
  const baseDir = join(d.dir, json.compilerOptions?.baseUrl ?? '.')
  const paths = json.compilerOptions?.paths ?? {}
  const aliases: Array<[string, string]> = Object.entries(paths).flatMap(([pattern, targets]) =>
    Array.isArray(targets) && typeof targets[0] === 'string'
      ? [[pattern.replace(/\*$/, ''), join(baseDir, targets[0].replace(/\*$/, ''))] as [string, string]]
      : [],
  )
  return { json, baseAllowJs, aliases }
}

function ancestors(dir: string, stop: string): string[] {
  const out: string[] = []
  for (let d = dir; ; d = dirname(d)) {
    out.push(d)
    if (d === stop || dirname(d) === d) return out
  }
}

/** Absolute paths (no extension) of the local modules a file imports. */
function importedFiles(file: string, text: string, aliases: Tsconfig['aliases']): string[] {
  const specs = [...text.matchAll(/(?:from\s+|import\s+|require\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]!)
  return specs.flatMap((spec) => {
    if (spec.startsWith('.')) return [stripExt(join(dirname(file), spec))]
    const alias = aliases.find(([prefix]) => prefix && spec.startsWith(prefix))
    return alias ? [stripExt(join(alias[1], spec.slice(alias[0].length)))] : []
  })
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
  if (rel(out).startsWith('..') || isAbsolute(rel(out)))
    return { error: `--out ${o.out} is outside the app (${d.dir}).` }
  if (/^(src\/)?app\//.test(rel(out)))
    return {
      error: `${rel(out)} is under app/, where expo-router treats every file as a route. Pick another --out.`,
    }
  const ts = /\.tsx?$/.test(out)
  const bin = binFor(d)
  const runFrom = posix(relative(cwd, d.dir)) || '.'
  const tsconfig = readTsconfig(d, fs)
  const actions: Action[] = []
  const files: InitReport['files'] = []
  const commented: InitReport['commented'] = []
  const todos: string[] = []

  // A generated file is written once. --force replaces it only while it is
  // init's own unedited output; an edited one gets a `.new` copy beside it.
  const generate = (path: string, content: string): 'written' | 'kept' | 'edited' => {
    const current = fs.read(path)
    if (current === undefined) {
      actions.push({ kind: 'write', path, content })
      files.push({ path: rel(path), status: 'written' })
      return 'written'
    }
    const pristine = isPristine(current)
    if (!o.force) {
      files.push({
        path: rel(path),
        status: 'skipped',
        note: pristine ? 'exists; --force regenerates it' : 'exists, edited since init wrote it',
      })
      return pristine ? 'kept' : 'edited'
    }
    if (pristine) {
      const same = current === content
      if (!same) actions.push({ kind: 'write', path, content })
      files.push({ path: rel(path), status: same ? 'unchanged' : 'written' })
      return 'written'
    }
    actions.push({ kind: 'write', path: `${path}.new`, content })
    files.push({
      path: rel(path),
      status: 'skipped',
      note: `edited since init wrote it, so --force left it; wrote ${rel(path)}.new to compare`,
    })
    files.push({ path: `${rel(path)}.new`, status: 'written' })
    return 'edited'
  }

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

  const existingText = fs.read(out)
  const existing = found.bridgeUsers.filter((f) => stripExt(join(d.dir, f)) !== stripExt(out))
  // The app mounts the bridge its own way: don't add a second one unless asked to.
  const elsewhere = existingText === undefined && existing.length > 0 && !o.out
  let state: 'written' | 'kept' | 'edited' | 'elsewhere' = 'elsewhere'
  if (elsewhere) {
    files.push({
      path: rel(out),
      status: 'skipped',
      note: `the app already uses the bridge in ${existing.join(', ')}; pass --out to write one anyway`,
    })
  } else {
    state = generate(
      out,
      renderBridgeFile({
        version: o.version,
        appName: d.appName,
        ts,
        expo: d.has.expo,
        expoRouter: d.has.expoRouter,
        reactQuery: d.has.reactQuery,
        webview: d.has.webview,
        network: o.network.enabled,
        reactNavigation: d.has.reactNavigation && !d.has.expoRouter,
        stores: d.has.zustand ? imported(found.stores) : undefined,
        mmkv: d.has.mmkv ? imported(found.mmkv) : undefined,
        realtime,
        realtimeTools,
      }),
    )
  }
  const wrote = state === 'written'
  // What the app ends up with when this run doesn't write the bridge file.
  const liveText = wrote
    ? undefined
    : elsewhere
      ? existing.map((f) => fs.read(join(d.dir, f)) ?? '').join('\n')
      : existingText
  const network = wrote ? o.network.enabled : /networkTools\s*\(/.test(liveText ?? '')
  const offline = wrote ? o.network.enabled : /\boffline\s*:/.test(liveText ?? '')

  if (wrote) {
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
  const missing =
    !wrote && liveText !== undefined
      ? MARKERS.filter(([lib, marker]) => d.has[lib] && !marker.test(liveText)).map(([, , dep]) => dep)
      : []

  const flows = join(d.dir, 'flows')
  generate(
    join(flows, 'smoke.flow.mjs'),
    renderSmokeFlow({ version: o.version, expoRouter: d.has.expoRouter, bin }),
  )
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
      files.push({ path, status: 'unchanged', ...(result.note && { note: result.note }) })
    }
  }
  patch('package.json', patchPackageScripts)
  patch(d.tsconfig, (text) => patchTsconfig(text, tsconfig.baseAllowJs))
  patch(d.oxlint, patchOxlint)
  patch(d.eslint, patchEslint)
  if (d.agentsFile) {
    const text = fs.read(d.agentsFile) ?? ''
    const path = posix(relative(d.dir, d.agentsFile))
    if (text.includes('.flow.mjs')) files.push({ path, status: 'unchanged' })
    else {
      const appDir = posix(relative(dirname(d.agentsFile), d.dir))
      actions.push({ kind: 'append', path: d.agentsFile, line: agentsLine(appDir, bin) })
      files.push({ path, status: 'appended' })
    }
  }

  const spec = `${PACKAGE}@^${o.version}`
  const install = installCommand(d.pm, spec)
  if (!d.installed && o.install) actions.unshift({ kind: 'install', command: install, cwd: d.dir })
  const skill = o.skillYes ? [...SKILL_RUN, '-y'] : SKILL_RUN
  if (o.skill) actions.push({ kind: 'skill', command: skill, cwd: d.repoRoot })

  const rootFile = d.rootFile ? join(d.dir, d.rootFile) : undefined
  const rootImports = rootFile
    ? importedFiles(rootFile, fs.read(rootFile) ?? '', tsconfig.aliases)
    : []
  const reachedFromRoot = (file: string) =>
    stripExt(file) === stripExt(rootFile ?? '') || rootImports.includes(stripExt(file))
  const mounted = elsewhere
    ? existing.some((f) => reachedFromRoot(join(d.dir, f)))
    : rootImports.includes(stripExt(out))
  const snippet = renderMountSnippet(importPath(rootFile ?? join(d.dir, 'App.tsx'), out))
  const where = elsewhere
    ? `The app already uses the bridge in ${existing.join(', ')}; make sure the root component renders it`
    : d.rootFile
      ? `Paste the import into ${d.rootFile} and the element into the root component's JSX`
      : `No root component found (looked for ${d.has.expoRouter ? 'app/_layout or src/app/_layout' : 'App or src/App'}): paste it into yours, fixing the import path`
  const note = `${where}${d.has.reactQuery && !elsewhere ? ', inside QueryClientProvider so query.* tools work' : ''}.`

  // The flag is only offered while --force would replace init's own unedited file.
  const regenerable = state === 'written' || state === 'kept'
  const ignored =
    o.network.chosen && !wrote && o.network.enabled !== network
      ? `${o.network.enabled ? '--network' : '--no-network'} had no effect: ${elsewhere ? existing.join(', ') : rel(out)} already exists${regenerable ? '; add --force to regenerate it' : '; edit it by hand'}.`
      : undefined
  const choice: InitReport['choices']['network'] = {
    enabled: network,
    open: !network && !(o.network.chosen && wrote),
    why: NETWORK_WHY,
    ...(regenerable && { flag: network ? '--no-network --force' : '--network --force' }),
    ...(!network && { lines: NETWORK_LINES }),
    ...(ignored && { note: ignored }),
  }

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
      choices: { network: choice },
      commented,
      todos,
      missing,
      existing,
      runFrom,
      scenarios: offline ? ['offline'] : [],
      ...nextSteps(bin, { mounted, offline, runFrom, elsewhere }),
    },
  }
}
