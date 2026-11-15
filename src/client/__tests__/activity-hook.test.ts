import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createActivityHook } from '../activity-hook'

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-hook-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20))
}

describe('activity hook', () => {
  test('none without a command', () => {
    expect(createActivityHook({ cwd: dir, report: () => {} })).toBeUndefined()
  })

  test('reads the environment unless useEnv is false', () => {
    process.env.AGENT_BRIDGE_ON_ACTIVITY = 'true'
    try {
      expect(createActivityHook({ cwd: dir, report: () => {} })).toBeDefined()
      expect(
        createActivityHook({ cwd: dir, report: () => {}, useEnv: false }),
      ).toBeUndefined()
    } finally {
      delete process.env.AGENT_BRIDGE_ON_ACTIVITY
    }
  })

  test('runs in the project dir, once per minute, never for bridge.ping', async () => {
    let t = 1_000_000
    const hook = createActivityHook({
      command: 'pwd >> out.txt',
      cwd: dir,
      report: () => {},
      now: () => t,
    })!
    hook.ran('bridge.ping')
    await new Promise((r) => setTimeout(r, 150))
    expect(existsSync(join(dir, 'out.txt'))).toBe(false)
    hook.ran('store.get')
    t += 59_000
    hook.ran('store.get')
    await until(() => existsSync(join(dir, 'out.txt')))
    expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe(`${dir}\n`)
    t += 1_000
    hook.ran('store.get')
    await until(() => readFileSync(join(dir, 'out.txt'), 'utf8').length > dir.length + 1)
    expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe(`${dir}\n${dir}\n`)
  })

  test('a failing or slow hook doesn\'t block, and a failure is reported once', async () => {
    let t = 0
    const reports: string[] = []
    const hook = createActivityHook({
      command: 'exit 3',
      cwd: dir,
      report: (text) => reports.push(text),
      now: () => t,
    })!
    const t0 = performance.now()
    hook.ran('store.get')
    expect(performance.now() - t0).toBeLessThan(50)
    await until(() => reports.length === 1)
    t += 120_000
    hook.ran('store.get')
    await new Promise((r) => setTimeout(r, 300))
    expect(reports).toEqual(['on-activity command "exit 3" exited with code 3'])

    const slow = createActivityHook({
      command: 'sleep 30',
      cwd: dir,
      report: () => {},
    })!
    const t1 = performance.now()
    slow.ran('store.get')
    expect(performance.now() - t1).toBeLessThan(50)
  })

  test('a missing directory is reported, not thrown', async () => {
    const reports: string[] = []
    const hook = createActivityHook({
      command: 'true',
      cwd: join(dir, 'gone'),
      report: (text) => reports.push(text),
    })!
    expect(() => hook.ran('store.get')).not.toThrow()
    await until(() => reports.length === 1)
    expect(reports).toHaveLength(1)
  })
})
