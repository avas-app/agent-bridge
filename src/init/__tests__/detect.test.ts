import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { type Detection, detect } from '../detect'
import { nodeFs } from '../index'
import { binFallback, detectPackageManager, installCommand } from '../package-manager'
import { scan } from '../scan'
import {
  BARE_JS,
  EXPO_PLAIN,
  EXPO_ROUTER_FULL,
  EXPO_ROUTER_ROOT,
  NOT_RN,
  PNPM_MONOREPO,
  YARN_MONOREPO,
  cleanupFixtures,
  fixture,
} from './fixtures'

afterEach(cleanupFixtures)

const ok = (d: ReturnType<typeof detect>): Detection => {
  if ('error' in d) throw new Error(d.error)
  return d
}

describe('detect', () => {
  test('expo-router app under src/app', () => {
    const dir = fixture(EXPO_ROUTER_FULL)
    const d = ok(detect(dir, nodeFs))
    expect(d).toMatchObject({
      appName: 'Sprout',
      pm: 'bun',
      typescript: true,
      srcDir: true,
      rootFile: 'src/app/_layout.tsx',
      tsconfig: 'tsconfig.json',
      eslint: 'eslint.config.js',
      agentsFile: join(dir, 'AGENTS.md'),
      installed: false,
    })
    expect(d.has).toMatchObject({ expo: true, expoRouter: true, reactQuery: true, zustand: true, socketIo: true, webview: false })
  })

  test('expo without a router mounts from App.tsx', () => {
    const d = ok(detect(fixture(EXPO_PLAIN), nodeFs))
    expect(d).toMatchObject({ rootFile: 'App.tsx', pm: 'npm', srcDir: false, appName: 'fixture-app' })
  })

  test('bare JS app: no TypeScript, yarn, oxlint', () => {
    const d = ok(detect(fixture(BARE_JS), nodeFs))
    expect(d).toMatchObject({
      typescript: false,
      pm: 'yarn',
      rootFile: 'App.js',
      oxlint: '.oxlintrc.json',
      eslint: 'eslint.config.mjs',
      appName: 'BareApp',
    })
    expect(d.has).toMatchObject({ reactNavigation: true, mmkv: true, expo: false })
  })

  test('expo-router with a root app/', () => {
    const d = ok(detect(fixture(EXPO_ROUTER_ROOT), nodeFs))
    expect(d).toMatchObject({ rootFile: 'app/_layout.tsx', srcDir: false })
  })

  test('a non-RN package is an error', () => {
    const d = detect(fixture(NOT_RN), nodeFs)
    expect(d).toEqual({ error: expect.stringContaining("isn't a React Native app") })
  })

  test('a pnpm monorepo root lists the RN workspaces', () => {
    const d = detect(fixture(PNPM_MONOREPO), nodeFs)
    expect(d).toMatchObject({ workspaces: ['apps/mobile'] })
    expect((d as { error: string }).error).toContain('--dir apps/mobile')
  })

  test('a yarn workspaces root lists the RN workspaces', () => {
    const d = detect(fixture(YARN_MONOREPO), nodeFs)
    expect(d).toMatchObject({ workspaces: ['apps/mobile'] })
  })

  test('inside a monorepo the lockfile comes from the workspace root', () => {
    const root = fixture(PNPM_MONOREPO)
    const d = ok(detect(join(root, 'apps/mobile'), nodeFs))
    expect(d).toMatchObject({ pm: 'pnpm', root, repoRoot: root })
    const y = fixture(YARN_MONOREPO)
    expect(ok(detect(join(y, 'apps/mobile'), nodeFs)).pm).toBe('yarn')
  })

  test('finds an installed bin walking up', () => {
    const root = fixture({ ...PNPM_MONOREPO, 'node_modules/.bin/agent-bridge': '' })
    expect(ok(detect(join(root, 'apps/mobile'), nodeFs)).bin).toBe(
      join(root, 'node_modules/.bin/agent-bridge'),
    )
  })
})

describe('package manager', () => {
  test('packageManager wins over lockfiles, then the user agent, then npm', () => {
    const dir = fixture({ 'package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }), 'yarn.lock': '' })
    expect(detectPackageManager(dir, dir, nodeFs)).toBe('pnpm')
    const bare = fixture({ 'package.json': '{}' })
    expect(detectPackageManager(bare, bare, nodeFs, 'yarn/4.1.0 npm/? node/v22')).toBe('yarn')
    expect(detectPackageManager(bare, bare, nodeFs)).toBe('npm')
    const bunb = fixture({ 'package.json': '{}', 'bun.lockb': '' })
    expect(detectPackageManager(bunb, bunb, nodeFs)).toBe('bun')
  })

  test('install commands and bins never use npx', () => {
    expect(installCommand('bun', 'x@^1').join(' ')).toBe('bun add -d x@^1')
    expect(installCommand('pnpm', 'x@^1').join(' ')).toBe('pnpm add -D x@^1')
    expect(installCommand('yarn', 'x@^1').join(' ')).toBe('yarn add -D x@^1')
    expect(installCommand('npm', 'x@^1').join(' ')).toBe('npm install -D x@^1')
    for (const pm of ['bun', 'pnpm', 'yarn', 'npm'] as const)
      expect(binFallback(pm)).not.toContain('npx')
  })
})

describe('scan', () => {
  test('finds stores and the socket, skipping tests', () => {
    expect(scan(fixture(EXPO_ROUTER_FULL), nodeFs)).toEqual({
      stores: [
        { name: 'useAuthStore', file: 'src/stores/auth.ts' },
        { name: 'useSettings', file: 'src/stores/settings.ts' },
      ],
      mmkv: [],
      socketIo: [{ name: 'socket', file: 'src/lib/socket.ts' }],
      ably: [],
    })
  })

  test('finds MMKV and Ably, typed or not, and ignores files without the import', () => {
    const dir = fixture({
      'lib/storage.ts': `import { createMMKV } from 'react-native-mmkv'\nexport const secure: MMKV = createMMKV({ id: 's' })\n`,
      'app/realtime.ts': `import * as Ably from 'ably'\nexport const client = new Ably.Realtime({ key })\n`,
      'src/other.ts': `export const useNot = create(() => ({}))\n`,
      'node_modules/x/index.js': `import { create } from 'zustand'\nexport const useHidden = create()\n`,
    })
    expect(scan(dir, nodeFs)).toEqual({
      stores: [],
      mmkv: [{ name: 'secure', file: 'lib/storage.ts' }],
      socketIo: [],
      ably: [{ name: 'client', file: 'app/realtime.ts' }],
    })
  })

  test('stops at the file cap', () => {
    const tree: Record<string, string> = {}
    for (let i = 0; i < 5; i++)
      tree[`src/s${i}.ts`] = `import { create } from 'zustand'\nexport const useS${i} = create(() => ({}))\n`
    expect(scan(fixture(tree), nodeFs, { maxFiles: 2 }).stores).toHaveLength(2)
  })
})
