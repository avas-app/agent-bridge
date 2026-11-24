import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bundlesWithBridge } from '../assert-absent'

const dir = mkdtempSync(join(tmpdir(), 'assert-absent-'))
const file = (name: string, text: string) => {
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}

test('a bundle with only the dials code fails', async () => {
  const dist = await Bun.file(join(import.meta.dir, '../../../dist/dials/index.cjs'))
    .text()
    .catch(() => null)
  // The built file exists after `bun run build`; the marker must be in it.
  if (dist !== null) expect(dist).toContain('@avasapp/agent-bridge/dials')
  const { DIALS_MARKER } = await import('../../dials/index')
  const bundle = file('app.js', `var x = ${JSON.stringify(DIALS_MARKER)}`)
  expect(await bundlesWithBridge([bundle])).toEqual([bundle])
})

test('the runtime marker and a clean bundle', async () => {
  const rt = file('rt.js', '@avasapp/agent-bridge/runtime')
  const clean = file('clean.js', 'var a = 1')
  expect(await bundlesWithBridge([rt, clean])).toEqual([rt])
})

test('the release stub has no marker', async () => {
  const text = await Bun.file(join(import.meta.dir, '../../noop/dials.ts')).text()
  expect(text).not.toContain('@avasapp/agent-bridge')
})
