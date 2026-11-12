import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkRunFlags, loadFlows, logToStderr, selectFlows, writeReport } from '../flow-cli'

const dir = mkdtempSync(join(tmpdir(), 'flow-cli-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const put = (name: string, body: string) => {
  mkdirSync(join(dir, 'f'), { recursive: true })
  writeFileSync(join(dir, 'f', name), body)
  return join(dir, 'f', name)
}

test('--out needs a report format, and a format must be known', () => {
  expect(() => checkRunFlags({ reporter: undefined, out: 'r.xml' })).toThrow('--out needs --reporter')
  expect(() => checkRunFlags({ reporter: 'text', out: 'r.xml' })).toThrow('--out needs --reporter')
  expect(() => checkRunFlags({ reporter: 'xml' })).toThrow('json or junit')
  expect(checkRunFlags({ reporter: 'junit', out: 'r.xml' })).toBe(true)
  expect(checkRunFlags({})).toBe(false)
})

test('a broken file or a bad export becomes a failed run, not a crash; paths are relative', async () => {
  const ok = put('ok.flow.mjs', 'export default async () => {}')
  const syntax = put('syntax.flow.mjs', 'export default async ( => {')
  const noFn = put('nofn.flow.mjs', 'export const x = 1')
  const badName = put('badname.flow.mjs', 'export const name = 42\nexport default async () => {}')
  const { entries, failures } = await loadFlows([ok, syntax, noFn, badName], dir)
  expect(entries.map((e) => [e.file, e.name])).toEqual([['f/ok.flow.mjs', 'ok']])
  expect(failures.map((f) => f.file)).toEqual(['f/syntax.flow.mjs', 'f/nofn.flow.mjs', 'f/badname.flow.mjs'])
  expect(failures.every((f) => f.status === 'failed')).toBe(true)
  expect(failures[1]!.error).toContain('export default')
  expect(failures[2]!.error).toContain('name')
})

test('--grep matches the name or the path relative to the folder, not the absolute path', async () => {
  const entries = [
    { file: 'flows/add.flow.mjs', name: 'add', module: { default: async () => {} } },
    { file: 'flows/rm.flow.mjs', name: 'remove', module: { default: async () => {} } },
  ]
  expect(selectFlows(entries, 'REMOVE').map((e) => e.name)).toEqual(['remove'])
  expect(selectFlows(entries, 'flows/add').map((e) => e.name)).toEqual(['add'])
  expect(selectFlows(entries, undefined)).toHaveLength(2)
  expect(selectFlows(entries, 'home/runner')).toHaveLength(0)
})

test('writeReport creates the folder and leaves no temp file', async () => {
  const out = join(dir, 'reports/deep/r.xml')
  await writeReport(out, '<x/>')
  expect(readFileSync(out, 'utf8')).toBe('<x/>\n')
  expect(readdirSync(join(dir, 'reports/deep'))).toEqual(['r.xml'])
  expect(existsSync(out)).toBe(true)
})

test('logToStderr sends console.log to stderr while it runs, then puts it back', async () => {
  const log = console.log
  const err = console.error
  const seen: string[] = []
  console.error = (...a: unknown[]) => void seen.push(a.join(' '))
  try {
    await logToStderr(async () => {
      console.log('from a flow')
    })
    expect(seen).toEqual(['from a flow'])
    expect(console.log).toBe(log)
  } finally {
    console.error = err
  }
})
