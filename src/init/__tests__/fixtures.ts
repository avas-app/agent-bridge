import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { type InitIo, nodeFs } from '../index'

export type Tree = Record<string, string>

const dirs: string[] = []
export const cleanupFixtures = () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

/** Writes the tree into a new temp dir, with a .git so walks stop there. */
export function fixture(tree: Tree): string {
  const root = mkdtempSync(join(tmpdir(), 'ab-init-'))
  dirs.push(root)
  mkdirSync(join(root, '.git'))
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

/** Every file under `root` except .git, by relative path. */
export function readTree(root: string): Tree {
  const out: Tree = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(root, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(root)
  return out
}

export type TestIo = InitIo & {
  out: string[]
  err: string[]
  execs: Array<{ command: string[]; cwd: string; interactive: boolean }>
  prompts: string[]
}

/** Real file access; exec and prompt are fakes that record what they were asked. */
export function testIo(
  cwd: string,
  {
    interactive = false,
    answer = '',
    execCode = 0,
    onExec,
  }: {
    interactive?: boolean
    answer?: string
    execCode?: number | 'timeout'
    onExec?: (command: string[], cwd: string) => void
  } = {},
): TestIo {
  const io: TestIo = {
    fs: nodeFs,
    write: (path, content) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    },
    append: (path, text) => writeFileSync(path, text, { flag: 'a' }),
    exec: async (command, cwd, interactive) => {
      io.execs.push({ command, cwd, interactive })
      onExec?.(command, cwd)
      return execCode
    },
    prompt: async (question) => {
      io.prompts.push(question)
      return answer
    },
    print: (text) => io.out.push(text),
    warn: (text) => io.err.push(text),
    interactive,
    cwd,
    userAgent: '',
    out: [],
    err: [],
    execs: [],
    prompts: [],
  }
  return io
}

const pkg = (deps: Record<string, string>, extra: object = {}) =>
  `${JSON.stringify({ name: 'fixture-app', version: '1.0.0', ...extra, dependencies: deps }, null, 2)}\n`

const TSCONFIG = `{\n  "extends": "expo/tsconfig.base",\n  "compilerOptions": { "strict": true }\n}\n`

/** create-expo-app's, which never includes .mjs. */
const EXPO_TSCONFIG = `{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"]
}
`

/** create-expo-app's flat config. */
export const EXPO_ESLINT = `// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
]);
`

/** 1. expo-router + React Query + zustand + socket.io under src/app. */
export const EXPO_ROUTER_FULL: Tree = {
  'package.json': pkg(
    {
      expo: '~57.0.0',
      'expo-router': '~57.0.0',
      '@tanstack/react-query': '^5.0.0',
      zustand: '^5.0.0',
      'socket.io-client': '^4.8.0',
      react: '19.2.0',
      'react-native': '0.86.0',
    },
    { devDependencies: { typescript: '~6.0.0' } },
  ),
  'app.json': JSON.stringify({ expo: { name: 'Sprout', slug: 'sprout' } }),
  'tsconfig.json': EXPO_TSCONFIG,
  'bun.lock': '',
  'eslint.config.js': EXPO_ESLINT,
  'AGENTS.md': '# Agents\n\n- Use bun.\n',
  'src/app/_layout.tsx': `import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Stack } from 'expo-router'

const client = new QueryClient()
export default function Layout() {
  return (
    <QueryClientProvider client={client}>
      <Stack />
    </QueryClientProvider>
  )
}
`,
  'src/app/index.tsx': `import { Text } from 'react-native'\nexport default () => <Text>Home</Text>\n`,
  'src/stores/auth.ts': `import { create } from 'zustand'

type Auth = { token: string | null }
export const useAuthStore = create<Auth>()(() => ({ token: null }))
`,
  'src/stores/settings.ts': `import { create } from 'zustand'
export const useSettings = create(() => ({ dark: false }))
`,
  'src/lib/socket.ts': `import { io } from 'socket.io-client'
export const socket = io('http://localhost:3000')
`,
  'src/stores/__tests__/auth.test.ts': `import { create } from 'zustand'\nexport const useFake = create(() => ({}))\n`,
}

/** 2. Expo without a router (App.tsx). */
export const EXPO_PLAIN: Tree = {
  'package.json': pkg({ expo: '~57.0.0', react: '19.2.0', 'react-native': '0.86.0' }),
  'tsconfig.json': TSCONFIG,
  'package-lock.json': '{}',
  'App.tsx': `import { Text } from 'react-native'\nexport default function App() {\n  return <Text>Hi</Text>\n}\n`,
}

/** 3. Bare React Native + React Navigation + MMKV, in JS with no tsconfig. */
export const BARE_JS: Tree = {
  'package.json': pkg({
    '@react-navigation/native': '^7.0.0',
    'react-native-mmkv': '^3.0.0',
    react: '19.2.0',
    'react-native': '0.86.0',
  }),
  'app.json': JSON.stringify({ name: 'BareApp', displayName: 'Bare App' }),
  'yarn.lock': '',
  '.oxlintrc.json': `{\n  "ignorePatterns": ["dist"]\n}\n`,
  'eslint.config.mjs': `import tseslint from 'typescript-eslint'\nexport default tseslint.config(tseslint.configs.recommended)\n`,
  'App.js': `import { NavigationContainer } from '@react-navigation/native'\nexport default function App() {\n  return <NavigationContainer />\n}\n`,
  'src/storage.js': `import { MMKV } from 'react-native-mmkv'\nexport const storage = new MMKV()\n`,
}

/** 4. A pnpm monorepo with apps/mobile. */
export const PNPM_MONOREPO: Tree = {
  'package.json': pkg({}, { private: true }),
  'pnpm-workspace.yaml': `packages:\n  - 'apps/*'\n  - "packages/*"\n`,
  'pnpm-lock.yaml': '',
  'apps/mobile/package.json': pkg({ expo: '~57.0.0', react: '19.2.0', 'react-native': '0.86.0' }),
  'apps/mobile/App.tsx': `export default function App() { return null }\n`,
  'apps/mobile/tsconfig.json': TSCONFIG,
  // A library: react-native only as a peer and dev dependency.
  'packages/ui/package.json': `${JSON.stringify({ name: 'ui', peerDependencies: { 'react-native': '*' }, devDependencies: { 'react-native': '0.86.0' } })}\n`,
}

/** 4b. The yarn-workspaces variant. */
export const YARN_MONOREPO: Tree = {
  'package.json': pkg({}, { private: true, workspaces: ['apps/*'] }),
  'yarn.lock': '',
  'apps/mobile/package.json': pkg({ react: '19.2.0', 'react-native': '0.86.0' }),
  'apps/mobile/App.js': `export default function App() { return null }\n`,
  'apps/web/package.json': pkg({ react: '19.2.0' }),
}

/** 5. Not a React Native package. */
export const NOT_RN: Tree = {
  'package.json': pkg({ react: '19.2.0' }),
}

/** 6. expo-router with a root app/ and no src/. */
export const EXPO_ROUTER_ROOT: Tree = {
  'package.json': pkg(
    { expo: '~57.0.0', 'expo-router': '~57.0.0', react: '19.2.0', 'react-native': '0.86.0', 'react-native-webview': '13.0.0' },
    { scripts: { flow: 'my-own-flow-runner' } },
  ),
  'tsconfig.json': `{\n  "extends": "expo/tsconfig.base",\n  "exclude": ["build"]\n}\n`,
  'app/_layout.tsx': `import { Stack } from 'expo-router'\nexport default function Layout() {\n  return <Stack />\n}\n`,
}
