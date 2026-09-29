import { expect, test } from 'bun:test'

// Fast Refresh re-runs startAgentBridge in the same module instance, so an id
// read from this module is the same for every start; only a reload (a fresh
// bundle, so a fresh module) draws a new one.
test('the load id is fixed for the life of the module', async () => {
  const first = (await import('../load-id')).loadId
  const second = (await import('../load-id')).loadId
  expect(first).toMatch(/^[a-z0-9]{4,}$/)
  expect(second).toBe(first)
})
