import type { Tools } from '../types'

const SUFFIX = '.restore'
const SELF = 'bridge.restore'
// Scenarios undo last: their guards (strict network, gates, fixtures) stay up
// until the other restorers have put the app back in its real state.
const LAST = 'scenario.restore'

/**
 * `bridge.restore` runs every tool whose name ends in `.restore`, so each
 * adapter (and the app) can undo what the agent changed in its own area.
 * `scenario.restore` goes last.
 */
export function restoreTools(getTools: () => Tools): Tools {
  return {
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
