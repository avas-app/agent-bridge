import { dirname, join } from 'node:path'

import type { ReadFs } from './detect'

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

const LOCKFILES: Array<[string, PackageManager]> = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

const fromName = (value: unknown): PackageManager | undefined => {
  const name = typeof value === 'string' ? value.split('@')[0] : undefined
  return name === 'bun' || name === 'pnpm' || name === 'yarn' || name === 'npm'
    ? name
    : undefined
}

/**
 * `packageManager` in the app's or the workspace root's package.json, then a
 * lockfile from the app dir up to the root, then the npm user agent, then npm.
 */
export function detectPackageManager(
  dir: string,
  root: string,
  fs: ReadFs,
  userAgent = '',
): PackageManager {
  for (const d of [dir, root]) {
    const pm = fromName(fs.readJson(join(d, 'package.json'))?.packageManager)
    if (pm) return pm
  }
  for (let d = dir; ; d = dirname(d)) {
    for (const [file, pm] of LOCKFILES) if (fs.exists(join(d, file))) return pm
    if (d === root || dirname(d) === d) break
  }
  return fromName(userAgent.split('/')[0]) ?? 'npm'
}

export function installCommand(pm: PackageManager, spec: string): string[] {
  switch (pm) {
    case 'bun':
      return ['bun', 'add', '-d', spec]
    case 'pnpm':
      return ['pnpm', 'add', '-D', spec]
    case 'yarn':
      return ['yarn', 'add', '-D', spec]
    case 'npm':
      return ['npm', 'install', '-D', spec]
  }
}

/** How to run the installed bin when no `.bin/agent-bridge` was found. Never npx. */
export function binFallback(pm: PackageManager): string {
  switch (pm) {
    case 'bun':
      return 'bunx agent-bridge'
    case 'pnpm':
      return 'pnpm exec agent-bridge'
    case 'yarn':
      return 'yarn agent-bridge'
    case 'npm':
      return './node_modules/.bin/agent-bridge'
  }
}
