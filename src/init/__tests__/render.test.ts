import { describe, expect, test } from 'bun:test'

import {
  patchEslint,
  patchOxlint,
  patchPackageScripts,
  patchTsconfig,
  renderBridgeFile,
  storeKey,
} from '../render'
import { EXPO_ESLINT } from './fixtures'

const text = (p: ReturnType<typeof patchTsconfig>) => {
  if (!('text' in p)) throw new Error(`expected a patch, got ${JSON.stringify(p)}`)
  return p.text
}

describe('patches', () => {
  test('tsconfig: adds exclude with node_modules, keeps an existing list, then is a no-op', () => {
    const added = text(patchTsconfig('{\n    "extends": "expo/tsconfig.base"\n}\n'))
    expect(JSON.parse(added).exclude).toEqual(['node_modules', '**/*.flow.*'])
    expect(added).toStartWith('{\n    "extends"')
    expect(added).toEndWith('}\n')
    expect(JSON.parse(text(patchTsconfig('{"exclude": ["build"]}'))).exclude).toEqual([
      'node_modules',
      'build',
      '**/*.flow.*',
    ])
    expect(patchTsconfig(added)).toEqual({ unchanged: true })
  })

  test('tsconfig with comments is printed, not rewritten', () => {
    expect(patchTsconfig('{\n  // base\n  "extends": "x"\n}')).toEqual({
      manual: expect.stringContaining('"exclude"'),
    })
  })

  test('oxlint: appends to ignorePatterns', () => {
    expect(JSON.parse(text(patchOxlint('{"ignorePatterns": ["dist"]}'))).ignorePatterns).toEqual([
      'dist',
      '**/*.flow.*',
    ])
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
