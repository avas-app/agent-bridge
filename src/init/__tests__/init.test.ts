import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { version } from '../../../package.json'
import { runInit } from '../index'
import type { InitReport } from '../plan'
import {
  BARE_JS,
  EXPO_PLAIN,
  EXPO_ROUTER_FULL,
  EXPO_ROUTER_ROOT,
  NOT_RN,
  PNPM_MONOREPO,
  type Tree,
  YARN_MONOREPO,
  cleanupFixtures,
  fixture,
  readTree,
  testIo,
} from './fixtures'

afterEach(cleanupFixtures)

const SPEC = `@avasapp/agent-bridge@^${version}`
// Snapshots shouldn't change on every release.
const unversioned = (s: string) => s.replaceAll(version, '<version>')

const loaderFor = (path: string) =>
  path.endsWith('.tsx') ? 'tsx' : path.endsWith('.ts') ? 'ts' : 'jsx'

/** Runs init in a fresh fixture; returns the tree, the parsed --json report and the io. */
async function initIn(
  tree: Tree,
  args: Parameters<typeof runInit>[0] = {},
  ioOptions: Parameters<typeof testIo>[1] = {},
  sub = '.',
) {
  const root = fixture(tree)
  const io = testIo(root, ioOptions)
  const code = await runInit({ json: true, dir: sub, ...args }, io)
  const report = args.json === false ? undefined : (JSON.parse(io.out.join('\n')) as InitReport)
  return { root, dir: join(root, sub), io, code, report, files: readTree(root) }
}

describe('generated files per app', () => {
  const cases: Array<[string, Tree, string, string]> = [
    ['expo-router + query + zustand + socket.io', EXPO_ROUTER_FULL, 'src/dev/agent-bridge.tsx', 'src/app/_layout.tsx'],
    ['expo without a router', EXPO_PLAIN, 'dev/agent-bridge.tsx', 'App.tsx'],
    ['bare RN + navigation + MMKV in JS', BARE_JS, 'src/dev/agent-bridge.js', 'App.js'],
    ['expo-router with a root app/ and a webview', EXPO_ROUTER_ROOT, 'dev/agent-bridge.tsx', 'app/_layout.tsx'],
  ]
  for (const [name, tree, bridge, rootFile] of cases) {
    test(name, async () => {
      for (const network of [false, true]) {
        const { code, report, files } = await initIn(tree, { network, skill: false })
        expect(code).toBe(0)
        const file = files[bridge]!
        expect(unversioned(file)).toMatchSnapshot()
        new Bun.Transpiler({ loader: loaderFor(bridge) }).transformSync(file)
        new Bun.Transpiler({ loader: 'js' }).transformSync(files['flows/smoke.flow.mjs']!)
        expect(report!.mount).toMatchSnapshot()
        expect(report!.mount.file).toBe(rootFile)
        // The snippet is valid once pasted into a component.
        const [importLine, element] = report!.mount.snippet.split('\n')
        new Bun.Transpiler({ loader: 'tsx' }).transformSync(
          `${importLine}\nexport default () => <>${element}</>`,
        )
        expect(file.includes('offline:')).toBe(network)
        expect(report!.next.some((s) => s.command?.includes('scenario.apply'))).toBe(network)
        expect(Object.keys(files).some((f) => /^(src\/)?app\/.*agent-bridge/.test(f))).toBe(false)
      }
    })
  }

  test('the smoke flow navigates home only with expo-router', async () => {
    const withRouter = await initIn(EXPO_ROUTER_FULL, { skill: false })
    expect(unversioned(withRouter.files['flows/smoke.flow.mjs']!)).toMatchSnapshot()
    const without = await initIn(EXPO_PLAIN, { skill: false })
    expect(without.files['flows/smoke.flow.mjs']).not.toContain('router.navigate')
    expect(without.files['flows/README.md']).toContain('.flow.mjs')
  })

  test('commented adapters and TODOs are explained in the file and the report', async () => {
    const { report, files } = await initIn(EXPO_ROUTER_FULL, { skill: false })
    const file = files['src/dev/agent-bridge.tsx']!
    expect(file).toContain("// import { useAuthStore } from '../stores/auth'")
    expect(file).toContain('they often hold tokens')
    expect(file).toContain('// In src/lib/socket.ts, right after `socket` is created, add:')
    expect(file).toContain('//   export const realtimeDevTools = socketIoTools(socket)')
    expect(report!.commented).toEqual([
      {
        adapter: 'zustand',
        items: ['useAuthStore (src/stores/auth.ts)', 'useSettings (src/stores/settings.ts)'],
        why: expect.stringContaining('redact'),
      },
    ])
    expect(report!.todos).toEqual([expect.stringContaining('In src/lib/socket.ts')])
    const bare = await initIn(BARE_JS, { skill: false })
    expect(bare.report!.commented.map((c) => c.adapter)).toEqual([
      'react-native-mmkv',
      '@react-navigation/native',
    ])
    expect(bare.files['src/dev/agent-bridge.js']).toContain("// import { storage } from '../storage'")
  })
})

test('a client the app already wraps is wired live, with no TODO', async () => {
  const { files, report } = await initIn(
    {
      ...EXPO_ROUTER_FULL,
      'src/lib/socket.ts': `import { socketIoTools } from '@avasapp/agent-bridge/socket.io'
import { io } from 'socket.io-client'
export const socket = io('http://localhost:3000')
export const realtimeDevTools = socketIoTools(socket)
`,
    },
    { skill: false },
  )
  const file = files['src/dev/agent-bridge.tsx']!
  expect(file).toContain("import { realtimeDevTools } from '../lib/socket'")
  expect(file).toContain('      ...realtimeDevTools,\n')
  expect(file).not.toContain('TODO socket.io')
  expect(report!.todos).toEqual([])
})

describe('side files', () => {
  test('patches tsconfig, eslint, package.json and AGENTS.md', async () => {
    const { files, report } = await initIn(EXPO_ROUTER_FULL, { skill: false })
    // create-expo-app's include never reaches .mjs, so tsconfig is left alone.
    expect(files['tsconfig.json']).toBe(EXPO_ROUTER_FULL['tsconfig.json']!)
    expect(files['eslint.config.js']).toContain("defineConfig([\n  { ignores: ['**/*.flow.*'] },")
    expect(JSON.parse(files['package.json']!).scripts).toEqual({ flow: 'agent-bridge run' })
    expect(files['AGENTS.md']).toBe(
      '# Agents\n\n- Use bun.\n- Flows for agent-bridge live in `flows/<name>.flow.mjs` (never under `app/`, never `*.test.*`); run one with `bunx @avasapp/agent-bridge run flows/smoke.flow.mjs`.\n',
    )
    expect(report!.files.map((f) => `${f.status} ${f.path}`)).toEqual([
      'written src/dev/agent-bridge.tsx',
      'written flows/smoke.flow.mjs',
      'written flows/README.md',
      'patched package.json',
      'unchanged tsconfig.json',
      'patched eslint.config.js',
      'appended AGENTS.md',
    ])
  })

  test('oxlint is patched; a complex eslint config is printed, not edited', async () => {
    const { files, report } = await initIn(BARE_JS, { skill: false })
    expect(JSON.parse(files['.oxlintrc.json']!).ignorePatterns).toEqual(['**/*.flow.*', 'dist'])
    expect(files['eslint.config.mjs']).toBe(BARE_JS['eslint.config.mjs']!)
    expect(report!.files).toContainEqual({
      path: 'eslint.config.mjs',
      status: 'manual',
      note: expect.stringContaining("{ ignores: ['**/*.flow.*'] },"),
    })
    // No tsconfig in a JS app, so none is created.
    expect(files['tsconfig.json']).toBeUndefined()
  })

  test('an existing flow script and tsconfig exclude are kept', async () => {
    const { files } = await initIn(EXPO_ROUTER_ROOT, { skill: false })
    expect(JSON.parse(files['package.json']!).scripts).toEqual({ flow: 'my-own-flow-runner' })
    expect(files['tsconfig.json']).toBe(
      '{\n  "extends": "expo/tsconfig.base",\n  "exclude": ["**/*.flow.*", "build"]\n}\n',
    )
  })
})

describe('install and skill', () => {
  const cases: Array<[string, Tree, string, string]> = [
    ['bun', EXPO_ROUTER_FULL, '.', `bun add -d ${SPEC}`],
    ['npm', EXPO_PLAIN, '.', `npm install -D ${SPEC}`],
    ['yarn', BARE_JS, '.', `yarn add -D ${SPEC}`],
    ['pnpm', PNPM_MONOREPO, 'apps/mobile', `pnpm add -D ${SPEC}`],
  ]
  for (const [pm, tree, sub, command] of cases) {
    test(`installs with ${pm} in the app dir`, async () => {
      const { io, report, dir } = await initIn(tree, { skill: false }, {}, sub)
      expect(io.execs).toEqual([{ command: command.split(' '), cwd: dir, interactive: false }])
      expect(report!.install).toEqual({ status: 'installed', command })
    })
  }

  test('--no-install prints the command; a present package is not reinstalled', async () => {
    const skipped = await initIn(EXPO_PLAIN, { install: false, skill: false })
    expect(skipped.io.execs).toEqual([])
    expect(skipped.report!.install).toEqual({ status: 'not-run', command: `npm install -D ${SPEC}` })
    const pkg = JSON.parse(EXPO_PLAIN['package.json']!)
    pkg.devDependencies = { '@avasapp/agent-bridge': '^0.4.0' }
    const present = await initIn({ ...EXPO_PLAIN, 'package.json': JSON.stringify(pkg) }, { skill: false })
    expect(present.io.execs).toEqual([])
    expect(present.report!.install.status).toBe('present')
  })

  test('runs the skills CLI at the repo root by default, never with --no-skill', async () => {
    const { io, report, root } = await initIn(PNPM_MONOREPO, { install: false }, {}, 'apps/mobile')
    expect(io.execs).toEqual([
      {
        command: ['npx', '--yes', 'skills', 'add', 'avas-app/agent-bridge', '-y'],
        cwd: root,
        interactive: false,
      },
    ])
    expect(report!.skill).toMatchObject({ status: 'added', command: 'npx skills add avas-app/agent-bridge' })
    expect(report!.skill.plugin).toHaveLength(2)
    const asked = await initIn(EXPO_PLAIN, { install: false, json: false, network: false }, { interactive: true })
    expect(asked.io.execs).toEqual([
      { command: ['npx', '--yes', 'skills', 'add', 'avas-app/agent-bridge'], cwd: asked.root, interactive: true },
    ])
    const none = await initIn(EXPO_PLAIN, { install: false, skill: false })
    expect(none.io.execs).toEqual([])
  })

  test('a failed skill install warns and carries on; a failed install exits 1', async () => {
    const { io, report, code, files } = await initIn(EXPO_PLAIN, {}, { execCode: 2 })
    expect(report!.skill.status).toBe('failed')
    expect(report!.install.status).toBe('failed')
    expect(io.err.join('\n')).toContain('Adding the skill failed')
    expect(files['dev/agent-bridge.tsx']).toBeDefined()
    expect(code).toBe(1)
    expect(report!.ok).toBe(false)
  })

  test('a timed-out install or skill is reported and init carries on', async () => {
    const { io, report, files } = await initIn(EXPO_PLAIN, {}, { execCode: 'timeout' })
    expect(report!.install).toMatchObject({ status: 'failed', error: 'timed out after 5 min' })
    expect(report!.skill).toMatchObject({ status: 'failed', error: 'timed out after 2 min' })
    expect(io.err.join('\n')).toContain('timed out')
    expect(files['dev/agent-bridge.tsx']).toBeDefined()
  })

  test('files that name the CLI use the bin the install just created', async () => {
    const { report, files } = await initIn(
      EXPO_ROUTER_FULL,
      { skill: false },
      { onExec: (_, cwd) => testIo(cwd).write(join(cwd, 'node_modules/.bin/agent-bridge'), '') },
    )
    expect(report!.next[2]!.command).toBe('./node_modules/.bin/agent-bridge session start')
    expect(files['flows/smoke.flow.mjs']).toContain('//   ./node_modules/.bin/agent-bridge run flows/smoke.flow.mjs')
    expect(files['AGENTS.md']).toContain('`./node_modules/.bin/agent-bridge run flows/smoke.flow.mjs`')
    for (const f of Object.values(files)) expect(f).not.toContain('bunx agent-bridge')
  })
})

describe('networkTools choice', () => {
  test('asked in a terminal: yes wires it and the offline scenario', async () => {
    const { io, files, report } = await initIn(
      EXPO_PLAIN,
      { json: false, skill: false },
      { interactive: true, answer: 'y' },
    )
    expect(io.prompts).toEqual([expect.stringContaining('fetch and XMLHttpRequest')])
    expect(files['dev/agent-bridge.tsx']).toContain('...networkTools(),')
    expect(files['dev/agent-bridge.tsx']).toContain('offline: {')
    expect(report).toBeUndefined()
    expect(io.out.join('\n')).toContain('Network tools: on')
  })

  test('asked in a terminal: no (or Enter) leaves it off, and the choice is closed', async () => {
    const { io, files } = await initIn(EXPO_PLAIN, { json: false, skill: false }, { interactive: true, answer: '' })
    expect(io.prompts).toHaveLength(1)
    expect(files['dev/agent-bridge.tsx']).not.toContain('networkTools')
    expect(io.out.join('\n')).toContain('Network tools: off. networkTools patches')
    expect(io.out.join('\n')).not.toContain('Open choice')
  })

  test('--network and --no-network skip the prompt', async () => {
    const on = await initIn(EXPO_PLAIN, { json: false, network: true, skill: false }, { interactive: true })
    expect(on.io.prompts).toEqual([])
    expect(on.files['dev/agent-bridge.tsx']).toContain('networkTools')
    const off = await initIn(EXPO_PLAIN, { json: false, network: false, skill: false }, { interactive: true })
    expect(off.io.prompts).toEqual([])
    expect(off.files['dev/agent-bridge.tsx']).not.toContain('networkTools')
  })

  test('--json, --yes and no TTY never ask, leave it off and list the open choice', async () => {
    for (const [args, interactive] of [
      [{ json: true }, true],
      [{ json: false, yes: true }, true],
      [{ json: false }, false],
    ] as const) {
      const { io, files } = await initIn(EXPO_PLAIN, { ...args, skill: false }, { interactive })
      expect(io.prompts).toEqual([])
      expect(files['dev/agent-bridge.tsx']).not.toContain('networkTools')
      if (args.json)
        expect(JSON.parse(io.out.join('\n')).choices.network).toEqual({
          enabled: false,
          open: true,
          flag: '--network --force',
          lines: [
            "import { networkTools } from '@avasapp/agent-bridge/network'",
            '...networkTools(),  // in useAgentBridge({ tools })',
          ],
          why: expect.stringContaining('fetch'),
        })
      else expect(io.out.join('\n')).toContain('Open choice:')
    }
  })
})

describe('re-runs', () => {
  test('--dry-run leaves the tree byte-identical and shows the files', async () => {
    const root = fixture(EXPO_ROUTER_FULL)
    const before = readTree(root)
    const io = testIo(root)
    expect(await runInit({ dryRun: true }, io)).toBe(0)
    expect(readTree(root)).toEqual(before)
    expect(io.execs).toEqual([])
    const out = io.out.join('\n')
    expect(out).toContain('Would run:')
    expect(out).toContain(`install   bun add -d ${SPEC}`)
    expect(out).toContain('--- src/dev/agent-bridge.tsx\n// Generated by agent-bridge init')
    const json = testIo(root)
    await runInit({ dryRun: true, json: true }, json)
    const report = JSON.parse(json.out.join('\n'))
    expect(report.dryRun).toBe(true)
    expect(report.contents['src/dev/agent-bridge.tsx']).toContain('useAgentBridge')
    expect(readTree(root)).toEqual(before)
  })

  test('a second run changes nothing and reports mount status and new adapters', async () => {
    const { root, files } = await initIn(EXPO_ROUTER_FULL, { skill: false })
    // The user mounts it and adds a webview.
    const pkg = JSON.parse(files['package.json']!)
    pkg.dependencies['react-native-webview'] = '13.0.0'
    pkg.devDependencies['@avasapp/agent-bridge'] = `^${version}`
    const io0 = testIo(root)
    io0.write(join(root, 'package.json'), JSON.stringify(pkg, null, 2))
    io0.write(
      join(root, 'src/app/_layout.tsx'),
      `import { AgentBridge } from '../dev/agent-bridge'\n${files['src/app/_layout.tsx']}`,
    )
    const before = readTree(root)
    const io = testIo(root)
    expect(await runInit({ json: true, skill: false }, io)).toBe(0)
    expect(readTree(root)).toEqual(before)
    expect(io.execs).toEqual([])
    const report = JSON.parse(io.out.join('\n')) as InitReport
    expect(report.files.map((f) => f.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
    ])
    expect(report.missing).toEqual(['react-native-webview'])
    expect(report.mount.mounted).toBe(true)
    expect(report.install.status).toBe('present')
    expect(report.next[0]!.step).not.toContain('Mount')
  })

  test('--force regenerates an unedited generated file', async () => {
    const { root } = await initIn(EXPO_PLAIN, { skill: false, install: false })
    const io = testIo(root)
    await runInit({ json: true, force: true, network: true, skill: false, install: false }, io)
    expect(readFileSync(join(root, 'dev/agent-bridge.tsx'), 'utf8')).toContain('networkTools')
    const report = JSON.parse(io.out.join('\n')) as InitReport
    expect(report.choices.network).toEqual({
      enabled: true,
      open: false,
      flag: '--no-network --force',
      why: expect.any(String),
    })
  })

  test('--force never overwrites an edited or hand-written file: it writes .new beside it', async () => {
    const { root, files } = await initIn(EXPO_PLAIN, { skill: false, install: false })
    const io0 = testIo(root)
    const edited = files['dev/agent-bridge.tsx']!.replace('tools: {', "tools: { 'my.tool': () => 1,")
    io0.write(join(root, 'dev/agent-bridge.tsx'), edited)
    io0.write(join(root, 'flows/smoke.flow.mjs'), '// mine\n')
    io0.write(join(root, 'flows/README.md'), 'mine\n')
    const io = testIo(root)
    await runInit({ json: true, force: true, network: true, skill: false, install: false }, io)
    expect(readFileSync(join(root, 'dev/agent-bridge.tsx'), 'utf8')).toBe(edited)
    expect(readFileSync(join(root, 'dev/agent-bridge.tsx.new'), 'utf8')).toContain('networkTools')
    expect(readFileSync(join(root, 'flows/smoke.flow.mjs'), 'utf8')).toBe('// mine\n')
    expect(readFileSync(join(root, 'flows/smoke.flow.mjs.new'), 'utf8')).toContain('screen.snapshot')
    expect(readFileSync(join(root, 'flows/README.md'), 'utf8')).toBe('mine\n')
    const report = JSON.parse(io.out.join('\n')) as InitReport
    expect(report.files.slice(0, 2)).toEqual([
      { path: 'dev/agent-bridge.tsx', status: 'skipped', note: expect.stringContaining('wrote dev/agent-bridge.tsx.new') },
      { path: 'dev/agent-bridge.tsx.new', status: 'written' },
    ])
    // The edited file decides, and the choice offers lines to add instead of a flag.
    expect(report.choices.network).toEqual({
      enabled: false,
      open: true,
      why: expect.any(String),
      lines: expect.any(Array),
      note: '--network had no effect: dev/agent-bridge.tsx already exists; edit it by hand.',
    })
  })

  test('--network on a re-run says it had no effect', async () => {
    const { root } = await initIn(EXPO_PLAIN, { skill: false, install: false })
    const io = testIo(root)
    await runInit({ json: false, network: true, skill: false, install: false }, io)
    expect(io.out.join('\n')).toContain(
      '--network had no effect: dev/agent-bridge.tsx already exists; add --force to regenerate it.',
    )
    expect(io.out.join('\n')).toContain("  import { networkTools } from '@avasapp/agent-bridge/network'")
  })

  test('a kept bridge file decides network and the offline step', async () => {
    const { root } = await initIn(EXPO_PLAIN, { skill: false, network: true })
    const io = testIo(root)
    await runInit({ json: true, skill: false }, io)
    const report = JSON.parse(io.out.join('\n')) as InitReport
    expect(report.choices.network.enabled).toBe(true)
    expect(report.next.map((s) => s.command)).toContain(`./node_modules/.bin/agent-bridge call scenario.apply '"offline"'`)
  })

  test('--out under app/ is refused', async () => {
    const { code, report } = await initIn(EXPO_ROUTER_ROOT, { out: 'app/dev.tsx', skill: false })
    expect(code).toBe(1)
    expect(report as unknown).toMatchObject({ ok: false, error: expect.stringContaining('under app/') })
  })
})

describe('mounting', () => {
  test('mounted means the root file imports the generated file, also through a paths alias', async () => {
    const layout = (spec: string) =>
      `import { AgentBridge } from '${spec}'\n${EXPO_ROUTER_FULL['src/app/_layout.tsx']}`
    for (const [spec, mounted] of [
      ['@/dev/agent-bridge', true],
      ['../dev/agent-bridge.tsx', true],
      ['../lib/agent-bridge', false],
    ] as const) {
      const { report } = await initIn(
        { ...EXPO_ROUTER_FULL, 'src/app/_layout.tsx': layout(spec) },
        { skill: false },
      )
      expect([spec, report!.mount.mounted]).toEqual([spec, mounted])
    }
  })

  test('an app that already uses the bridge gets no second bridge file unless --out is given', async () => {
    const tree = {
      ...EXPO_ROUTER_FULL,
      'src/app/_layout.tsx': `import { useAgentBridge } from '@avasapp/agent-bridge'\nexport default function L() { useAgentBridge({ tools: {} }); return null }\n`,
    }
    const { report, files } = await initIn(tree, { skill: false })
    expect(files['src/dev/agent-bridge.tsx']).toBeUndefined()
    expect(report!.existing).toEqual(['src/app/_layout.tsx'])
    expect(report!.files[0]).toEqual({
      path: 'src/dev/agent-bridge.tsx',
      status: 'skipped',
      note: 'the app already uses the bridge in src/app/_layout.tsx; pass --out to write one anyway',
    })
    expect(report!.mount.mounted).toBe(true)
    const forced = await initIn(tree, { skill: false, out: 'src/dev/bridge.tsx' })
    expect(forced.files['src/dev/bridge.tsx']).toContain('useAgentBridge')
    expect(forced.report!.mount.mounted).toBe(false)
  })

  test('--out is relative to the cwd and must stay inside the app', async () => {
    const root = fixture({ ...PNPM_MONOREPO })
    const io = testIo(root)
    expect(
      await runInit({ json: true, dir: 'apps/mobile', out: 'apps/mobile/tools/bridge.tsx', skill: false, install: false }, io),
    ).toBe(0)
    expect(readTree(root)['apps/mobile/tools/bridge.tsx']).toContain('useAgentBridge')
    const outside = testIo(root)
    expect(await runInit({ json: true, dir: 'apps/mobile', out: 'bridge.tsx' }, outside)).toBe(1)
    expect(JSON.parse(outside.out.join('\n')).error).toContain('outside the app')
  })
})

describe('monorepos', () => {
  test('the AGENTS.md line and the prompt say where to run from', async () => {
    const { report, files } = await initIn(
      { ...PNPM_MONOREPO, 'AGENTS.md': '# Agents\n' },
      { skill: false, install: false },
      {},
      'apps/mobile',
    )
    expect(files['AGENTS.md']).toBe(
      '# Agents\n- Flows for agent-bridge live in `apps/mobile/flows/<name>.flow.mjs` (never under `app/`, never `*.test.*`); run one from `apps/mobile` with `pnpm exec agent-bridge run flows/smoke.flow.mjs`.\n',
    )
    expect(report!.runFrom).toBe('apps/mobile')
    expect(report!.prompt).toContain('From `apps/mobile`: start a session with `pnpm exec agent-bridge session start`')
  })
})

describe('errors and the report', () => {
  test('a non-RN package exits 1', async () => {
    const { code, report, io } = await initIn(NOT_RN)
    expect(code).toBe(1)
    expect(report as unknown).toEqual({ ok: false, error: expect.stringContaining("isn't a React Native app") })
    const text = await initIn(NOT_RN, { json: false })
    expect(text.code).toBe(1)
    expect(text.io.err.join('\n')).toContain('--dir')
    expect(io.execs).toEqual([])
  })

  test('a monorepo root exits 1 and names the app', async () => {
    for (const tree of [PNPM_MONOREPO, YARN_MONOREPO]) {
      const { code, report, files } = await initIn(tree)
      expect(code).toBe(1)
      expect(report as unknown).toMatchObject({ ok: false, workspaces: ['apps/mobile'] })
      expect(Object.keys(files).sort()).toEqual(Object.keys(tree).sort())
    }
  })

  test('the --json shape is stable', async () => {
    const { report } = await initIn(EXPO_ROUTER_FULL, { skill: false })
    expect(Object.keys(report!).sort()).toEqual([
      'app',
      'choices',
      'commented',
      'dryRun',
      'existing',
      'files',
      'install',
      'missing',
      'mount',
      'next',
      'ok',
      'prompt',
      'runFrom',
      'scenarios',
      'skill',
      'todos',
      'version',
    ])
    expect(report!.app).toEqual({
      dir: expect.any(String),
      name: 'Sprout',
      packageManager: 'bun',
      detected: ['expo', 'expo-router', '@tanstack/react-query', 'zustand', 'socket.io-client'],
    })
    expect(report!.next.map((s) => s.command ?? s.step)).toEqual([
      'Mount it: paste the snippet above',
      'Reload the app (press r in Metro)',
      'bunx @avasapp/agent-bridge session start',
      'bunx @avasapp/agent-bridge tools',
      'bunx @avasapp/agent-bridge call screen.snapshot',
      'bunx @avasapp/agent-bridge session stop',
    ])
  })

  test('the steps run from the app dir with a bin found walking up', async () => {
    const { report } = await initIn(
      { ...PNPM_MONOREPO, 'node_modules/.bin/agent-bridge': '' },
      { skill: false },
      {},
      'apps/mobile',
    )
    expect(report!.runFrom).toBe('apps/mobile')
    expect(report!.next[2]!.command).toBe('../../node_modules/.bin/agent-bridge session start')
  })

  test('the CLI: init --dry-run --json', () => {
    const root = fixture(EXPO_ROUTER_FULL)
    const before = readTree(root)
    const result = spawnSync(
      'bun',
      [resolve(import.meta.dir, '../../cli.ts'), 'init', '--dry-run', '--json', '--dir', root],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({ ok: true, dryRun: true, app: { name: 'Sprout' } })
    expect(report.choices.network.open).toBe(true)
    expect(readTree(root)).toEqual(before)
  })
})
