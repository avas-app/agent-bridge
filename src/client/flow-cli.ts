import { mkdir, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import { type FlowEntry, type FlowModule, type FlowRun, flowScenarios } from './flow'
import { flowName } from './flow-files'

const REPORTERS = ['text', 'json', 'junit']

/** Checks `run`'s flags before anything runs; true when a machine-readable report is wanted. */
export function checkRunFlags(flags: { reporter?: string; out?: string }): boolean {
  const reporter = flags.reporter ?? 'text'
  if (!REPORTERS.includes(reporter))
    throw new Error(`--reporter is text, json or junit, not ${reporter}`)
  if (flags.out && reporter === 'text')
    throw new Error('--out needs --reporter json or junit (run: --out is the report file)')
  return reporter !== 'text'
}

/** A run that failed before it could start: a file that won't load, or no app to connect to. */
export const failedRun = (file: string, name: string, error: string): FlowRun => ({
  file,
  name,
  status: 'failed',
  ms: 0,
  steps: 0,
  errors: 0,
  error,
  restoreErrors: [],
  notices: [],
})

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Imports each flow file. One that won't load (syntax error, no default
 * function, a `name` that isn't a string, a bad scenario) is returned as a
 * failed run so a report still lists it. `file` is shown relative to `cwd`.
 */
export async function loadFlows(
  files: string[],
  cwd = process.cwd(),
): Promise<{ entries: FlowEntry[]; failures: FlowRun[] }> {
  const root = await realpath(cwd).catch(() => cwd)
  const entries: FlowEntry[] = []
  const failures: FlowRun[] = []
  for (const abs of files) {
    const file = relative(root, abs).split('\\').join('/')
    try {
      const module = (await import(pathToFileURL(abs).href)) as FlowModule
      if (typeof module.default !== 'function')
        throw new Error(`${file} has no \`export default async ({ step }) => {}\``)
      if (module.name !== undefined && typeof module.name !== 'string')
        throw new Error(`${file}: \`export const name\` must be a string, not ${typeof module.name}`)
      // Before connecting, so a bad declaration fails fast.
      flowScenarios(module)
      entries.push({ file, name: flowName(abs, module.name), module })
    } catch (error) {
      failures.push(failedRun(file, flowName(abs), reason(error)))
    }
  }
  return { entries, failures }
}

/** The flows whose name, or path relative to the folder you ran from, contains `grep` (case-insensitive). */
export function selectFlows(entries: FlowEntry[], grep?: string): FlowEntry[] {
  if (!grep) return entries
  const needle = grep.toLowerCase()
  return entries.filter((e) => `${e.name}\n${e.file}`.toLowerCase().includes(needle))
}

/** Writes the report through a temp file, so a crash can't leave half a report; creates the folder. */
export async function writeReport(out: string, doc: string): Promise<void> {
  await mkdir(dirname(out), { recursive: true })
  const tmp = join(dirname(out), `.${process.pid}-${Date.now()}.tmp`)
  await writeFile(tmp, doc.endsWith('\n') ? doc : `${doc}\n`)
  await rename(tmp, out)
}

/** Runs `fn` with console.log going to stderr, so a flow's own output can't corrupt a report on stdout. */
export async function logToStderr<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log
  console.log = (...args: unknown[]) => console.error(...args)
  try {
    return await fn()
  } finally {
    console.log = log
  }
}
