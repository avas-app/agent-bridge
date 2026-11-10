import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { flowName, resolveFlowFiles } from '../flow-files'

const dir = mkdtempSync(join(tmpdir(), 'flows-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
mkdirSync(join(dir, 'flows/sub'), { recursive: true })
for (const f of ['b.flow.mjs', 'a.flow.mjs', 'x.txt', 'sub/c.flow.mjs'])
  writeFileSync(join(dir, 'flows', f), '')

test('a directory means its *.flow.mjs, sorted; a file and a glob work; typos throw', async () => {
  const names = (files: string[]) => files.map((f) => f.slice(dir.length + 1))
  expect(names(await resolveFlowFiles(['flows'], dir))).toEqual([
    'flows/a.flow.mjs',
    'flows/b.flow.mjs',
    'flows/sub/c.flow.mjs',
  ])
  expect(names(await resolveFlowFiles(['flows/b.flow.mjs', 'flows/b.flow.mjs'], dir))).toEqual(['flows/b.flow.mjs'])
  expect(names(await resolveFlowFiles(['flows/*.flow.mjs'], dir))).toEqual(['flows/a.flow.mjs', 'flows/b.flow.mjs'])
  expect(names(await resolveFlowFiles(['flows/**/c.flow.mjs'], dir))).toEqual(['flows/sub/c.flow.mjs'])
  await expect(resolveFlowFiles(['nope'], dir)).rejects.toThrow('No such flow file')
  await expect(resolveFlowFiles(['flows/*.nothing'], dir)).rejects.toThrow('No flow files match')
})

test('flowName', () => {
  expect(flowName('/x/main-tabs.flow.mjs')).toBe('main-tabs')
  expect(flowName('/x/y.mjs')).toBe('y')
  expect(flowName('/x/y.flow.mjs', 'Custom')).toBe('Custom')
})

test('globs only match *.flow.mjs, and a trailing ** matches files', async () => {
  const rel = (files: string[]) => files.map((f) => f.slice(dir.length + 1))
  writeFileSync(join(dir, 'flows/demo.mjs'), '')
  expect(rel(await resolveFlowFiles(['flows/**/*'], dir))).toEqual([
    'flows/a.flow.mjs',
    'flows/b.flow.mjs',
    'flows/sub/c.flow.mjs',
  ])
  expect(rel(await resolveFlowFiles(['flows/*.mjs'], dir))).toEqual(['flows/a.flow.mjs', 'flows/b.flow.mjs'])
  expect(rel(await resolveFlowFiles(['flows/**'], dir))).toEqual([
    'flows/a.flow.mjs',
    'flows/b.flow.mjs',
    'flows/sub/c.flow.mjs',
  ])
})

test('symlinked folders are followed, duplicates are found by real path, numbers sort naturally', async () => {
  const d = mkdtempSync(join(tmpdir(), 'flows-links-'))
  try {
    mkdirSync(join(d, 'real'))
    for (const f of ['10.flow.mjs', '2.flow.mjs', '1.flow.mjs']) writeFileSync(join(d, 'real', f), '')
    symlinkSync(join(d, 'real'), join(d, 'link'))
    const names = (files: string[]) => files.map((f) => f.slice(realpathSync(d).length + 1))
    expect(names(await resolveFlowFiles(['real'], d))).toEqual(['real/1.flow.mjs', 'real/2.flow.mjs', 'real/10.flow.mjs'])
    expect(names(await resolveFlowFiles(['link'], d))).toEqual(['real/1.flow.mjs', 'real/2.flow.mjs', 'real/10.flow.mjs'])
    expect(await resolveFlowFiles(['real', 'link', 'link/1.flow.mjs'], d)).toHaveLength(3)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})
