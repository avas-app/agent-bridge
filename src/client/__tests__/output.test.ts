import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { cdpTransport } from '../../runtime/cdp-transport'
import { createRegistry } from '../../runtime/registry'
import {
  type CallMessage,
  type DeviceInfo,
  PROTOCOL_VERSION,
} from '../../shared/protocol'
import { OUTPUT_LIMIT_BYTES, renderResult, shapeOf } from '../output'
import { bigValue } from './big-value'
import { startFakeMetro } from './fake-metro'

const dirs: string[] = []
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ab-out-'))
  dirs.push(d)
  return d
}

describe('renderResult', () => {
  test('prints small results as they are', async () => {
    expect(await renderResult({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  test('summarises a big result as valid JSON with the size and a hint', async () => {
    const value = bigValue(OUTPUT_LIMIT_BYTES * 2)
    const summary = JSON.parse(await renderResult(value))
    expect(summary.resultTooLarge).toBe(true)
    expect(summary.bytes).toBeGreaterThan(OUTPUT_LIMIT_BYTES)
    expect(summary.shape).toEqual({ rows: `array(${value.rows.length})` })
    expect(summary.hint).toContain('--out')
  })

  test('--full prints it all, --out writes it and prints the shape', async () => {
    const value = bigValue(OUTPUT_LIMIT_BYTES * 2)
    expect(JSON.parse(await renderResult(value, { full: true }))).toEqual(value)
    const file = join(tmp(), 'r.json')
    const printed = JSON.parse(await renderResult(value, { out: file }))
    expect(printed).toMatchObject({ file, shape: { rows: expect.any(String) } })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(value)
    expect(printed.bytes).toBeGreaterThan(OUTPUT_LIMIT_BYTES)
  })

  test('shapeOf describes the top level', () => {
    expect(shapeOf([{ a: 1 }, 2])).toEqual({
      type: 'array(2)',
      first: 'object(1 keys)',
    })
    expect(shapeOf({ a: 'xy', b: null })).toEqual({ a: 'string(2)', b: 'null' })
    expect(shapeOf(5)).toEqual({ type: 'number' })
  })
})

describe('agent-bridge call with a 2 MB result', () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ stdout: string; code: number | null }>((done) => {
      const child = spawn(
        'bun',
        [resolve(import.meta.dir, '../../cli.ts'), ...args],
        { env: { ...process.env, ...env } },
      )
      let stdout = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (c) => {
        stdout += c
      })
      child.on('close', (code) => done({ stdout, code }))
    })

  test('prints a summary, or the whole valid JSON with --full, or writes --out', async () => {
    const registry = createRegistry(() => ({
      'demo.big': (bytes: number) => bigValue(bytes),
    }))
    const info = (): DeviceInfo => ({
      deviceId: 'dev',
      name: 'Fake Phone',
      platform: 'ios',
      protocol: PROTOCOL_VERSION,
      tools: registry.list(),
    })
    const metro = await startFakeMetro({
      acceptOrigin: (port) => `http://localhost:${port}`,
    })
    cleanups.push(
      metro.close,
      cdpTransport().start({
        info,
        dispatch: (call: CallMessage) => registry.dispatch(call, 'dev'),
      }),
    )
    const base = ['--metro', metro.metro, '--transport', 'cdp', '--no-session']
    const call = ['call', 'demo.big', '2000000']
    const value = bigValue(2_000_000)
    const env = { AGENT_BRIDGE_STATE_DIR: tmp() }

    const summary = await run([...call, ...base], env)
    expect(summary.code).toBe(0)
    expect(summary.stdout.length).toBeLessThan(2000)
    expect(JSON.parse(summary.stdout).resultTooLarge).toBe(true)

    const full = await run([...call, '--full', ...base], env)
    expect(JSON.parse(full.stdout)).toEqual(value)

    const file = join(tmp(), 'out.json')
    const out = await run([...call, '--out', file, ...base], env)
    expect(JSON.parse(out.stdout).file).toBe(file)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(value)
  })
})
