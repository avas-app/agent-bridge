import { expect, mock, test } from 'bun:test'

import { TOOL_DESCRIPTIONS } from '../tools/descriptions'

mock.module('react-native', () => ({
  Dimensions: { get: () => ({ width: 1, height: 1 }) },
  DevSettings: { reload() {} },
}))

test('every built-in tool has a shared description, and the reverse', async () => {
  const { builtinTools } = await import('../builtin-tools')
  const logs = { read: () => [], clear() {}, begin: () => () => {}, takeErrors: () => [] }
  // Scenarios are on so scenario.* are registered too.
  const tools = builtinTools(
    () => [],
    () => tools,
    logs as never,
    () => ({}),
  )
  expect(Object.keys(tools).sort()).toEqual(Object.keys(TOOL_DESCRIPTIONS).sort())
  for (const [name, definition] of Object.entries(tools)) {
    const description = typeof definition === 'function' ? undefined : definition.description
    expect(description).toBe(TOOL_DESCRIPTIONS[name as keyof typeof TOOL_DESCRIPTIONS])
  }
})
