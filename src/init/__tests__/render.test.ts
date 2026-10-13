import { describe, expect, test } from 'bun:test'

import { addToArray, parseJsonc } from '../jsonc'
import {
  includesFlows,
  isPristine,
  patchEslint,
  patchOxlint,
  patchPackageScripts,
  patchTsconfig,
  renderBridgeFile,
  renderSmokeFlow,
  stamp,
  storeKey,
} from '../render'
import { EXPO_ESLINT } from './fixtures'

const text = (p: ReturnType<typeof patchTsconfig>) => {
  if (!('text' in p)) throw new Error(`expected a patch, got ${JSON.stringify(p)}`)
  return p.text
}

describe('jsonc', () => {
  test('parses comments and trailing commas, not strings that look like them', () => {
    expect(parseJsonc('{\n  // c\n  "a": "x//y", /* b */ "b": [1,],\n}')).toEqual({ a: 'x//y', b: [1] })
    expect(parseJsonc('{ nope')).toBeUndefined()
  })

  test('adds to an array or a new key, keeping the rest of the text', () => {
    const jsonc = '{\n  // keep me\n  "a": 1, /* and me */\n  "list": [\n    "x"\n  ],\n}\n'
    expect(addToArray(jsonc, 'list', 'y')).toBe(
      '{\n  // keep me\n  "a": 1, /* and me */\n  "list": [\n    "y",\n    "x"\n  ],\n}\n',
    )
    expect(addToArray(jsonc, 'other', 'y', ['z'])).toBe(
      '{\n  // keep me\n  "a": 1, /* and me */\n  "list": [\n    "x"\n  ],\n  "other": ["z", "y"],\n}\n',
    )
    expect(addToArray('{"a": []}', 'a', 'y')).toBe('{"a": ["y"]}')
    expect(addToArray('{}', 'a', 'y')).toBe('{\n  "a": ["y"]}')
    expect(addToArray('{"a": 1}', 'a', 'y')).toBeUndefined()
  })
})

describe('patches', () => {
  test('tsconfig: skipped when it never type checks .mjs (create-expo-app, allowJs off)', () => {
    const expo = '{\n  "extends": "expo/tsconfig.base",\n  "include": ["**/*.ts", "**/*.tsx"]\n}\n'
    expect(patchTsconfig(expo, true)).toEqual({ unchanged: true, note: "doesn't include .mjs files" })
    expect(patchTsconfig('{"compilerOptions": {"allowJs": false}}')).toMatchObject({ unchanged: true })
    expect(patchTsconfig('{"extends": "x"}', false)).toMatchObject({ unchanged: true })
  })

  test('tsconfig: extends without exclude is printed, since an exclude would replace the inherited one', () => {
    expect(patchTsconfig('{\n  "extends": "expo/tsconfig.base"\n}\n')).toEqual({
      manual: expect.stringContaining('inherits from "expo/tsconfig.base"'),
    })
  })

  test('tsconfig: adds to exclude in place, keeping comments', () => {
    const jsonc = '{\n  // mine\n  "compilerOptions": { "allowJs": true },\n  "exclude": ["build"],\n}\n'
    const patched = text(patchTsconfig(jsonc))
    expect(patched).toBe(
      '{\n  // mine\n  "compilerOptions": { "allowJs": true },\n  "exclude": ["**/*.flow.*", "build"],\n}\n',
    )
    expect(patchTsconfig(patched)).toEqual({ unchanged: true })
    expect(parseJsonc(text(patchTsconfig('{"compilerOptions": {}}')))).toEqual({
      compilerOptions: {},
      exclude: ['node_modules', '**/*.flow.*'],
    })
  })

  test('includesFlows', () => {
    for (const p of ['**/*', 'flows', './flows/**/*', '**/*.mjs', 'flows/*.flow.*'])
      expect([p, includesFlows(p)]).toEqual([p, true])
    for (const p of ['*', '**/*.ts', 'src', 'src/**/*', '**/*.js'])
      expect([p, includesFlows(p)]).toEqual([p, false])
  })

  test('oxlint: adds to ignorePatterns', () => {
    expect(parseJsonc(text(patchOxlint('{"ignorePatterns": ["dist"]}')))).toEqual({
      ignorePatterns: ['**/*.flow.*', 'dist'],
    })
  })

  test('package.json: adds the flow script, keeps an existing one', () => {
    expect(JSON.parse(text(patchPackageScripts('{"name": "a"}'))).scripts).toEqual({
      flow: 'agent-bridge run',
    })
    expect(patchPackageScripts('{"scripts": {"flow": "mine"}}')).toEqual({ unchanged: true })
  })

  test('eslint: prepends to defineConfig([...]) and a plain array', () => {
    const patched = text(patchEslint(EXPO_ESLINT))
    expect(patched).toContain("module.exports = defineConfig([\n  { ignores: ['**/*.flow.*'] },\n  expoConfig,")
    expect(patchEslint(patched)).toEqual({ unchanged: true })
    expect(text(patchEslint('export default [\n  js.configs.recommended,\n]\n'))).toBe(
      "export default [\n  { ignores: ['**/*.flow.*'] },\n  js.configs.recommended,\n]\n",
    )
  })

  test('eslint: anything else gets the snippet printed', () => {
    for (const config of [
      'export default tseslint.config(a, b)\n',
      'const config = [a]\nexport default config\n',
      'export default [a]\nmodule.exports = [b]\n',
    ])
      expect(patchEslint(config)).toEqual({
        manual: expect.stringContaining("{ ignores: ['**/*.flow.*'] },"),
      })
  })
})

describe('bridge file', () => {
  const base = {
    version: '1.2.3',
    appName: "Ada's app",
    ts: true,
    expo: false,
    expoRouter: false,
    reactQuery: false,
    webview: false,
    network: false,
    reactNavigation: false,
    realtime: [],
  }

  test('the minimum is CDP only, with a commented signedIn and no offline scenario', () => {
    const file = renderBridgeFile(base)
    expect(file).toContain('transports: [cdpTransport()]')
    expect(file).toContain("name: 'Ada\\'s app'")
    expect(file).toContain('// signedIn: {')
    expect(file).not.toContain('offline')
    expect(file).not.toContain('networkTools')
    new Bun.Transpiler({ loader: 'tsx' }).transformSync(file)
  })

  test('uncommenting the suggested lines gives valid code', () => {
    const file = renderBridgeFile({
      ...base,
      stores: [{ name: 'useAuthStore', from: '../stores/auth' }],
      mmkv: [{ name: 'storage', from: '../storage' }],
      reactNavigation: true,
      realtime: [{ kind: 'socket.io', name: 'socket', file: 'src/socket.ts' }],
    })
    const uncommented = file
      .split('\n')
      .map((l) => l.replace(/^(\s*)\/\/ (import \{|\.\.\.|'nav\.)/, '$1$2'))
      .join('\n')
    expect(uncommented).toContain("import { useAuthStore } from '../stores/auth'")
    expect(uncommented).toContain("...storeTools({ auth: useAuthStore }, { redact: { auth: ['token'] } }),")
    new Bun.Transpiler({ loader: 'tsx' }).transformSync(uncommented)
  })

  test('storeKey', () => {
    expect(storeKey('useAuthStore')).toBe('auth')
    expect(storeKey('useSettings')).toBe('settings')
    expect(storeKey('useStore')).toBe('useStore')
    expect(storeKey('cartStore')).toBe('cart')
  })
})

describe('stamp', () => {
  test('a generated file is pristine until edited', () => {
    const file = renderSmokeFlow({ version: '1.2.3', expoRouter: false, bin: 'x' })
    expect(file).toMatch(/^\/\/ Generated by agent-bridge init 1\.2\.3 \(#[0-9a-f]{12}\)\. Run it with:\n/)
    expect(isPristine(file)).toBe(true)
    expect(isPristine(file.replace('snapshot', 'snap'))).toBe(false)
    expect(isPristine(`// mine\n${file}`)).toBe(false)
    expect(isPristine(file.replace(/ \(#\w+\)/, ''))).toBe(false)
    expect(stamp(stamp(file))).toBe(file)
  })
})
