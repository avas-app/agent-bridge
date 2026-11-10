import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'

const FLOW_SUFFIX = /\.flow\.mjs$/

/** `*` stays in one path segment, `**` crosses them, `?` is one character. */
function globRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

const collator = new Intl.Collator('en', { numeric: true })
const posix = (p: string) => p.split('\\').join('/')
/** Natural order on '/'-separated paths, so 2 comes before 10 on every machine. */
const byPath = (a: string, b: string) => collator.compare(posix(a), posix(b))

/** Every file under `dir`, following symlinked folders once each. */
async function walk(dir: string, seen = new Set<string>()): Promise<string[]> {
  const real = await realpath(dir)
  if (seen.has(real)) return []
  seen.add(real)
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    const isDir = e.isDirectory() || (e.isSymbolicLink() && (await stat(full).catch(() => null))?.isDirectory())
    if (isDir) out.push(...(await walk(full, seen)))
    else out.push(full)
  }
  return out
}

/**
 * Flow files for `run`'s arguments, in argument order, as real paths: a file
 * as given, a directory's `*.flow.mjs` (recursively, naturally sorted), or a
 * glob (which only matches `*.flow.mjs`). Nothing matching is an error, so a
 * typo can't pass as an empty run.
 */
export async function resolveFlowFiles(args: string[], cwd = process.cwd()): Promise<string[]> {
  const files: string[] = []
  const seen = new Set<string>()
  for (const given of args) {
    // On Windows a backslash separates folders; elsewhere it escapes a character.
    const arg = process.platform === 'win32' ? given.split('\\').join('/') : given
    const path = resolve(cwd, arg)
    const info = await stat(path).catch(() => null)
    let found: string[]
    if (info?.isDirectory())
      found = (await walk(path)).filter((f) => FLOW_SUFFIX.test(f)).sort(byPath)
    else if (info) found = [path]
    else if (/[*?]/.test(arg)) {
      const fixed = arg.split('/').findIndex((seg) => /[*?]/.test(seg))
      const base = resolve(cwd, arg.split('/').slice(0, fixed).join('/') || '.')
      const re = globRegExp(posix(relative(cwd, resolve(cwd, arg))))
      found = (await walk(base).catch(() => []))
        .filter((f) => FLOW_SUFFIX.test(f) && re.test(posix(relative(cwd, f))))
        .sort(byPath)
    } else throw new Error(`No such flow file or directory: ${given}`)
    if (!found.length) throw new Error(`No flow files match ${given} (a directory or glob only finds *.flow.mjs)`)
    for (const f of found) {
      const real = await realpath(f)
      if (!seen.has(real)) {
        seen.add(real)
        files.push(real)
      }
    }
  }
  return files
}

/** The name a flow goes by: its `name` export, else the file name without `.flow.mjs`. */
export const flowName = (file: string, exported?: string) =>
  exported ?? basename(file).replace(FLOW_SUFFIX, '').replace(/\.[mc]?[jt]s$/, '')
