import type { Tools } from '../types'

const SUFFIX = '.restore'
const SELF = 'bridge.restore'
// Scenarios undo last: their guards (strict network, gates, fixtures) stay up
// until the other restorers have put the app back in its real state.
const LAST = 'scenario.restore'

/**
 * What each area's `pending` hook reports, keyed by area (`store`, `query`,
 * ...). A hook that returns a value other than a boolean is showing detail;
 * `true` means "something, no detail". Areas with nothing pending are left out.
 */
export function pendingByArea(
  tools: Tools,
  detail = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, d] of Object.entries(tools)) {
    if (!name.endsWith(SUFFIX) || name === SELF || typeof d === 'function')
      continue
    const area = name.slice(0, -SUFFIX.length)
    try {
      const found = d.pending?.({ detail })
      if (found) out[area] = found
    } catch (error) {
      // A hook that throws still means something may be pending: never drop the area.
      out[area] = `pending check failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return out
}

/**
 * `bridge.restore` runs every tool whose name ends in `.restore`, so each
 * adapter (and the app) can undo what the agent changed in its own area.
 * `scenario.restore` goes last.
 */
export function restoreTools(getTools: () => Tools): Tools {
  return {
    'bridge.pending': {
      maxArgs: 0,
      description:
        'What bridge.restore would undo right now, per area (store, query, net, app, ...): the value is true, or detail such as a store\'s snapshot against its current value. Empty when nothing is pending. Changes nothing.',
      run: () => pendingByArea(getTools(), true),
    },
    [SELF]: {
      description:
        'Undo what the agent changed: runs every *.restore tool in name order, scenario.restore last, and returns each result or error.',
      run: async () => {
        const tools = getTools()
        const results: Record<string, unknown> = {}
        const names = Object.keys(tools)
          .filter((name) => name.endsWith(SUFFIX) && name !== SELF)
          .sort((a, b) => Number(a === LAST) - Number(b === LAST) || a.localeCompare(b))
        // One at a time, so restorers never race each other on shared state.
        for (const name of names) {
          const definition = tools[name]!
          const run =
            typeof definition === 'function' ? definition : definition.run
          try {
            results[name] = await run()
          } catch (error) {
            results[name] = {
              error: error instanceof Error ? error.message : String(error),
            }
          }
        }
        return results
      },
    },
  }
}
