// Typechecks scripts/consumer-types/app.ts against the built package installed
// the way an app installs it. An adapter typed with a library's own class
// fails here: the app resolves that library's ESM types, our .d.cts its CJS ones.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const app = mkdtempSync(join(tmpdir(), 'agent-bridge-consumer-'))
const modules = join(app, 'node_modules')

try {
  const pkg = join(modules, '@avasapp/agent-bridge')
  for (const file of ['package.json', 'dist', 'entries'])
    cpSync(join(root, file), join(pkg, file), { recursive: true })
  for (const dep of ['@tanstack/query-core', 'ably', 'socket.io-client', 'zustand']) {
    mkdirSync(dirname(join(modules, dep)), { recursive: true })
    symlinkSync(join(root, 'node_modules', dep), join(modules, dep), 'dir')
  }
  for (const file of ['app.ts', 'tsconfig.json'])
    cpSync(join(root, 'scripts/consumer-types', file), join(app, file))

  execFileSync(
    process.execPath,
    [join(root, 'node_modules/typescript/bin/tsc'), '-p', app],
    { stdio: 'inherit' },
  )
  console.log('Consumer types OK.')
} catch {
  process.exitCode = 1
} finally {
  rmSync(app, { recursive: true, force: true })
}
