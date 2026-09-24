import { afterEach, describe, expect, test } from 'bun:test'

import { settle } from '../settle'
import { host, installHook } from './fake-tree'

const DEFAULT_LANE = 32
const OFFSCREEN_LANE = 1 << 29

let remove = () => {}
afterEach(() => remove())

describe('settle', () => {
  test('returns after one tick when nothing is queued', async () => {
    const fake = installHook([{ current: host(), pendingLanes: OFFSCREEN_LANE }])
    remove = fake.remove
    const result = await settle()
    expect(result.commits).toBe(0)
    expect(result.ms).toBeLessThan(15)
  })

  test('waits for queued work to commit, chaining the original hook', async () => {
    const root = { current: host(), pendingLanes: DEFAULT_LANE }
    const fake = installHook([root])
    remove = fake.remove
    setTimeout(() => {
      root.pendingLanes = 0
      fake.commit(root)
    }, 20)
    const result = await settle()
    expect(result.commits).toBe(1)
    expect(result.ms).toBeGreaterThanOrEqual(18)
    expect(fake.original).toEqual([[1, root]])
  })

  test('waits for commits caused by earlier commits, until a quiet frame', async () => {
    const root = { current: host(), pendingLanes: 0 }
    const fake = installHook([root])
    remove = fake.remove
    // A commit lands in the first tick, and an effect commits again within a frame.
    setTimeout(() => fake.commit(), 0)
    setTimeout(() => fake.commit(), 10)
    const settling = settle()
    expect((await settling).commits).toBe(2)
  })

  test('gives up after maxMs when work stays queued', async () => {
    const fake = installHook([{ current: host(), pendingLanes: DEFAULT_LANE }])
    remove = fake.remove
    const result = await settle({ maxMs: 60 })
    expect(result.ms).toBeGreaterThanOrEqual(60)
    expect(result.ms).toBeLessThan(120)
  })

  test('works without a DevTools hook', async () => {
    expect((await settle()).commits).toBe(0)
  })
})
