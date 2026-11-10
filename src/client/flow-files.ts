import { readdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'

const FLOW_SUFFIX = /\.flow\.mjs$/

/** `*` stays in one path segment, `**` crosses them, `?` is one character. */
function globRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') i++
      re += '(?:.*/)?'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

/**
 * Flow files for `run`'s arguments, in argument order: a file as given, a
 * directory's `*.flow.mjs` (recursively, sorted), or a glob. Nothing matching
 * is an error, so a typo can't pass as an empty run.
 */
export async function resolveFlowFiles(args: string[], cwd = process.cwd()): Promise<string[]> {
  const files: string[] = []
  for (const arg of args) {
    const path = resolve(cwd, arg)
    const info = await stat(path).catch(() => null)
    let found: string[]
    if (info?.isDirectory())
      found = (await walk(path)).filter((f) => FLOW_SUFFIX.test(f)).sort()
    else if (info) found = [path]
    else if (/[*?]/.test(arg)) {
      const fixed = arg.split('/').findIndex((seg) => /[*?]/.test(seg))
      const base = resolve(cwd, arg.split('/').slice(0, fixed).join('/') || '.')
      const re = globRegExp(relative(cwd, resolve(cwd, arg)).split('\\').join('/'))
      found = (await walk(base).catch(() => []))
        .filter((f) => re.test(relative(cwd, f).split('\\').join('/')))
        .sort()
    } else throw new Error(`No such flow file or directory: ${arg}`)
    if (!found.length) throw new Error(`No flow files match ${arg} (a directory is searched for *.flow.mjs)`)
    for (const f of found) if (!files.includes(f)) files.push(f)
  }
  return files
}

/** The name a flow goes by: its `name` export, else the file name without `.flow.mjs`. */
export const flowName = (file: string, exported?: string) =>
  exported ?? basename(file).replace(FLOW_SUFFIX, '').replace(/\.[mc]?[jt]s$/, '')
