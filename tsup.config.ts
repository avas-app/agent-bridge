import { defineConfig } from 'tsup'

const appEntries = {
  'runtime/index': 'src/runtime/index.ts',
  'expo/index': 'src/expo/index.ts',
  'adapters/tanstack-query': 'src/adapters/tanstack-query.ts',
  'adapters/zustand': 'src/adapters/zustand.ts',
  'adapters/react-native-mmkv': 'src/adapters/react-native-mmkv.ts',
  'adapters/expo-router': 'src/adapters/expo-router.ts',
  'network/index': 'src/network/index.ts',
}

const noopEntries = {
  'noop/index': 'src/noop/index.ts',
  'noop/expo': 'src/noop/expo.ts',
  'noop/tanstack-query': 'src/noop/tanstack-query.ts',
  'noop/zustand': 'src/noop/zustand.ts',
  'noop/react-native-mmkv': 'src/noop/react-native-mmkv.ts',
  'noop/expo-router': 'src/noop/expo-router.ts',
  'noop/network': 'src/noop/network.ts',
}

export default defineConfig([
  // In the app: CommonJS for Metro, reached through entries/*.cjs.
  {
    entry: { ...appEntries, ...noopEntries },
    format: ['cjs'],
    dts: { entry: appEntries },
    target: 'es2020',
    platform: 'neutral',
    external: [
      'react',
      'react-native',
      'expo/devtools',
      '@tanstack/query-core',
    ],
    outExtension: () => ({ js: '.cjs' }),
  },
  // On the agent's machine: the client library and the CLI.
  {
    entry: { 'client/index': 'src/client/index.ts', cli: 'src/cli.ts' },
    format: ['esm'],
    dts: { entry: { 'client/index': 'src/client/index.ts' } },
    target: 'node20',
    platform: 'node',
  },
  {
    entry: { 'client/index': 'src/client/index.ts' },
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
  },
])
