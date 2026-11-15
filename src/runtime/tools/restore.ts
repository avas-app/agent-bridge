import type { Tools } from '../types'
import { INTERNAL_TOOLS, TOOL_DESCRIPTIONS } from './descriptions'

export { INTERNAL_TOOLS }

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

/** What each area could undo from persistent storage; see `ToolDefinition.journal`. */
export function journalByArea(tools: Tools): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, d] of restorers(tools)) {
    try {
      const data = d.journal?.()
      if (data !== undefined) out[name] = data
    } catch {
      // An area that can't say is left out; its undo is lost on reload, as before.
    }
  }
  return out
}

/** Sum of the areas' `journalRev`. */
export function journalRev(tools: Tools): number {
  let rev = 0
  for (const [, d] of restorers(tools)) rev += d.journalRev?.() ?? 0
  return rev
}

function restorers(tools: Tools) {
  return Object.entries(tools)
    .filter(([name, d]) => name.endsWith(SUFFIX) && name !== SELF && typeof d !== 'function')
    .map(([name, d]) => [name.slice(0, -SUFFIX.length), d] as const)
    .filter((e): e is [string, Exclude<typeof e[1], (...a: never[]) => unknown>] => typeof e[1] !== 'function')
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
      description: TOOL_DESCRIPTIONS['bridge.pending'],
      run: () => pendingByArea(getTools(), true),
    },
    'bridge.adopt': {
      maxArgs: 1,
      description: TOOL_DESCRIPTIONS['bridge.adopt'],
      run: async (data: Record<string, unknown>) => {
        const tools = getTools()
        const out: Record<string, unknown> = {}
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('bridge.adopt takes an object')
        for (const [area, part] of Object.entries(data)) {
          const d = tools[`${area}${SUFFIX}`]
          if (typeof d === 'function' || !d?.adopt) out[area] = { adopted: [], already: [], changed: [], retry: part, error: 'this area has no adopt' }
          else
            try {
              out[area] = await d.adopt(part)
            } catch (error) {
              out[area] = { adopted: [], already: [], changed: [], retry: part, error: error instanceof Error ? error.message : String(error) }
            }
        }
        return out
      },
    },
    [SELF]: {
      description: TOOL_DESCRIPTIONS['bridge.restore'],
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
