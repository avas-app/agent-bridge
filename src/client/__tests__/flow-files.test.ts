import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
