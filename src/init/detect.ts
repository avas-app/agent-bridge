import { dirname, join, relative } from 'node:path'

import {
  type PackageManager,
  detectPackageManager,
} from './package-manager'

/** Read-only file access, injected so the planning code has no side effects. */
export type ReadFs = {
  exists: (path: string) => boolean
  read: (path: string) => string | undefined
  /** Undefined when missing or not valid JSON. */
  // oxlint-disable-next-line no-explicit-any -- package.json and friends are untyped
  readJson: (path: string) => any
  list: (dir: string) => Array<{ name: string; dir: boolean }>
}

export const PACKAGE = '@avasapp/agent-bridge'

/** Libraries init knows how to wire, by the dependency that signals them. */
export const LIBRARIES = {
  expo: 'expo',
  expoRouter: 'expo-router',
  reactQuery: '@tanstack/react-query',
  webview: 'react-native-webview',
  zustand: 'zustand',
  mmkv: 'react-native-mmkv',
  ably: 'ably',
  socketIo: 'socket.io-client',
  reactNavigation: '@react-navigation/native',
  typescript: 'typescript',
} as const

export type Library = keyof typeof LIBRARIES

export type Detection = {
  /** Absolute app directory. */
  dir: string
  /** The workspace root, or `dir` outside a monorepo. */
  root: string
  /** The nearest directory with `.git`, or `root`. */
  repoRoot: string
  /** What `devices` and `--device` match on. */
  appName: string
  pm: PackageManager
  has: Record<Library, boolean>
  /** The package is already a dependency. */
  installed: boolean
  typescript: boolean
  srcDir: boolean
  /** The root component file, relative to `dir`. */
  rootFile?: string
  /** Relative to `dir`. */
  tsconfig?: string
  oxlint?: string
  eslint?: string
  /** Absolute path of the AGENTS.md or CLAUDE.md to note flows in. */
  agentsFile?: string
  /** Absolute path of an installed `.bin/agent-bridge`. */
  bin?: string
}

export type DetectError = {
  error: string
  /** Workspace packages that depend on react-native, relative to `dir`. */
  workspaces?: string[]
}

const SOURCE_EXTS = ['tsx', 'ts', 'jsx', 'js']

// oxlint-disable-next-line no-explicit-any -- package.json is untyped
const depsOf = (pkg: any): Record<string, string> => ({
  ...pkg?.peerDependencies,
  ...pkg?.devDependencies,
  ...pkg?.dependencies,
})

const isWorkspaceRoot = (dir: string, fs: ReadFs) =>
  !!fs.readJson(join(dir, 'package.json'))?.workspaces ||
  fs.exists(join(dir, 'pnpm-workspace.yaml'))

function findUp(
  dir: string,
  fs: ReadFs,
  test: (d: string) => boolean,
): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (test(d)) return d
    if (fs.exists(join(d, '.git')) || dirname(d) === d) return undefined
  }
}

/** Workspace globs from package.json `workspaces` and pnpm-workspace.yaml. */
export function workspacePatterns(root: string, fs: ReadFs): string[] {
  const ws = fs.readJson(join(root, 'package.json'))?.workspaces
  const fromPkg: unknown[] = Array.isArray(ws) ? ws : (ws?.packages ?? [])
  const yaml = fs.read(join(root, 'pnpm-workspace.yaml')) ?? ''
  const block = yaml.match(/^packages:\s*\n((?:[ \t]*(?:-.*|#.*)?\n?)*)/m)?.[1] ?? ''
  const fromYaml = [...block.matchAll(/^[ \t]*-[ \t]*['"]?([^'"#\n]+?)['"]?[ \t]*$/gm)].map(
    (m) => m[1]!,
  )
  return [...fromPkg, ...fromYaml].filter(
    (p): p is string => typeof p === 'string' && !p.startsWith('!'),
  )
}

/** Directories with a package.json that match the globs (`*` and `**` only). */
export function expandWorkspaces(
  root: string,
  patterns: string[],
  fs: ReadFs,
): string[] {
  const found = new Set<string>()
  const walk = (dir: string, segments: string[], depth: number) => {
    if (!segments.length) {
      if (fs.exists(join(dir, 'package.json'))) found.add(dir)
      return
    }
    const [head, ...rest] = segments
    const children = () =>
      fs
        .list(dir)
        .filter((e) => e.dir && e.name !== 'node_modules' && !e.name.startsWith('.'))
    if (head === '**') {
      walk(dir, rest, depth)
      if (depth < 4)
        for (const c of children()) walk(join(dir, c.name), segments, depth + 1)
    } else if (head!.includes('*')) {
      const re = new RegExp(
        `^${head!.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
      )
      for (const c of children())
        if (re.test(c.name)) walk(join(dir, c.name), rest, depth)
    } else {
      walk(join(dir, head!), rest, depth)
    }
  }
  for (const p of patterns)
    walk(root, p.replace(/\/+$/, '').split('/').filter((s) => s && s !== '.'), 0)
  return [...found].sort()
}

const firstExisting = (dir: string, fs: ReadFs, candidates: string[]) =>
  candidates.find((c) => fs.exists(join(dir, c)))

const withExts = (base: string) => SOURCE_EXTS.map((e) => `${base}.${e}`)

/** Everything init needs to know about the app, read through `fs` only. */
export function detect(
  dir: string,
  fs: ReadFs,
  env: { userAgent?: string } = {},
): Detection | DetectError {
  const pkg = fs.readJson(join(dir, 'package.json'))
  if (!pkg) return { error: `No package.json in ${dir}.` }
  const deps = depsOf(pkg)
  if (!deps['react-native']) {
    if (isWorkspaceRoot(dir, fs)) {
      const apps = expandWorkspaces(dir, workspacePatterns(dir, fs), fs)
        .filter((d) => depsOf(fs.readJson(join(d, 'package.json')))['react-native'])
        .map((d) => relative(dir, d))
      return {
        error: apps.length
          ? `${dir} is a monorepo root. Rerun with --dir pointing at the app: ${apps.map((a) => `--dir ${a}`).join(', ')}`
          : `${dir} is a monorepo root and no workspace package depends on react-native.`,
        workspaces: apps,
      }
    }
    return {
      error: `${dir} isn't a React Native app: its package.json has no react-native dependency. Pass --dir <app>.`,
    }
  }

  const root = findUp(dir, fs, (d) => isWorkspaceRoot(d, fs)) ?? dir
  const repoRoot = findUp(dir, fs, (d) => fs.exists(join(d, '.git'))) ?? root
  const has = Object.fromEntries(
    Object.entries(LIBRARIES).map(([k, dep]) => [k, !!deps[dep]]),
  ) as Record<Library, boolean>
  const appJson = fs.readJson(join(dir, 'app.json'))
  const appName =
    [appJson?.expo?.name, appJson?.name, pkg.name].find(
      (n): n is string => typeof n === 'string' && !!n,
    ) ?? 'app'
  const tsconfig = firstExisting(dir, fs, ['tsconfig.json'])
  const rootFile = firstExisting(
    dir,
    fs,
    has.expoRouter
      ? [...withExts('app/_layout'), ...withExts('src/app/_layout')]
      : [...withExts('App'), ...withExts('src/App')],
  )
  const agentsFile = [...new Set([dir, repoRoot])]
    .flatMap((d) => [join(d, 'AGENTS.md'), join(d, 'CLAUDE.md')])
    .find((f) => fs.exists(f))
  let bin: string | undefined
  for (let d = dir; ; d = dirname(d)) {
    const candidate = join(d, 'node_modules', '.bin', 'agent-bridge')
    if (fs.exists(candidate)) {
      bin = candidate
      break
    }
    if (d === repoRoot || dirname(d) === d) break
  }

  return {
    dir,
    root,
    repoRoot,
    appName,
    pm: detectPackageManager(dir, root, fs, env.userAgent),
    has,
    installed: !!deps[PACKAGE],
    typescript: !!tsconfig || has.typescript,
    srcDir: fs.exists(join(dir, 'src')),
    rootFile,
    tsconfig,
    oxlint: firstExisting(dir, fs, ['.oxlintrc.json']),
    eslint: firstExisting(dir, fs, [
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
    ]),
    agentsFile,
    bin,
  }
}
