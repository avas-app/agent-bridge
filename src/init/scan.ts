import { join, relative } from 'node:path'

import type { ReadFs } from './detect'

/** A variable the scan found, and the file (relative to the app) that creates it. */
export type Found = { name: string; file: string }

export type ScanResult = {
  stores: Found[]
  mmkv: Found[]
  socketIo: Found[]
  ably: Found[]
  /** Realtime tools the app already exports from where its client is created. */
  realtimeTools: Found[]
}

const CODE = /\.(tsx?|jsx?|mjs|cjs)$/
const TESTS = /\.(test|spec)\.|(^|\/)__tests__\//

const imports = (text: string, module: string) =>
  new RegExp(
    `(from\\s+|require\\(\\s*)['"]${module.replace(/[.]/g, '\\.')}(/[\\w./-]+)?['"]`,
  ).test(text)

// `: Type` between the name and `=`, as in `export const storage: MMKV = new MMKV()`.
const TYPED = '(?:\\s*:[^=]+)?'
const PATTERNS: Array<[keyof ScanResult, string, RegExp]> = [
  ['stores', 'zustand', new RegExp(`export\\s+const\\s+(use\\w+)${TYPED}\\s*=\\s*create\\w*\\s*[<(]`, 'g')],
  ['mmkv', 'react-native-mmkv', new RegExp(`export\\s+const\\s+(\\w+)${TYPED}\\s*=\\s*(?:new\\s+MMKV|createMMKV)\\s*[<(]`, 'g')],
  ['socketIo', 'socket.io-client', new RegExp(`(?:const|let)\\s+(\\w+)${TYPED}\\s*=\\s*io\\s*\\(`, 'g')],
  ['ably', 'ably', new RegExp(`(?:const|let)\\s+(\\w+)${TYPED}\\s*=\\s*new\\s+(?:Ably\\.)?Realtime(?:\\.Promise)?\\s*\\(`, 'g')],
  ['realtimeTools', '@avasapp/agent-bridge', /export\s+const\s+(\w+)\s*=\s*(?:socketIoTools|ablyTools)\s*\(/g],
]

/**
 * Finds zustand stores, MMKV instances and realtime clients with regexes, in
 * src/, app/, lib/ and the app's top-level files. A miss only costs a comment.
 */
export function scan(
  dir: string,
  fs: ReadFs,
  { maxFiles = 2000, maxBytes = 512 * 1024 } = {},
): ScanResult {
  const files: string[] = []
  const walk = (d: string, deep: boolean) => {
    const entries = fs.list(d).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const e of entries) {
      if (files.length >= maxFiles) return
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const path = join(d, e.name)
      if (e.dir) {
        if (deep) walk(path, true)
      } else if (CODE.test(e.name) && !TESTS.test(relative(dir, path))) {
        files.push(path)
      }
    }
  }
  walk(dir, false)
  for (const sub of ['src', 'app', 'lib']) walk(join(dir, sub), true)

  const result: ScanResult = { stores: [], mmkv: [], socketIo: [], ably: [], realtimeTools: [] }
  for (const path of files) {
    const text = fs.read(path)
    if (!text || text.length > maxBytes) continue
    for (const [key, module, re] of PATTERNS) {
      if (!imports(text, module)) continue
      for (const m of text.matchAll(re))
        result[key].push({ name: m[1]!, file: relative(dir, path) })
    }
  }
  return result
}
