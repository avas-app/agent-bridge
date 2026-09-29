import { checkOptions } from '../options-schema'
import type { ScenarioContext, Scenarios, ToolFn, Tools } from '../types'

type Active = { options: unknown; undos: Array<() => unknown> }

// Module level, so a remount of the hook (Fast Refresh) can still undo what
// the previous one applied.
const active = new Map<string, Active>()

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** Runs undo callbacks newest first. Returns the errors, keyed by position. */
async function runUndos(entry: Active): Promise<string[]> {
  const errors: string[] = []
  for (const undo of entry.undos.splice(0).reverse()) {
    try {
      await undo()
    } catch (error) {
      errors.push(message(error))
    }
  }
  return errors
}

async function undo(name: string): Promise<string[]> {
  const entry = active.get(name)
  if (!entry) return []
  active.delete(name)
  return (await runUndos(entry)).map((e) => `${name}: ${e}`)
}

/**
 * `scenario.*`: the app's named setups. `scenario.restore` runs every active
 * scenario's undo callbacks; `bridge.restore` runs it after all other restorers.
 */
export function scenarioTools(
  getScenarios: () => Scenarios,
  getTools: () => Tools,
): Tools {
  const find = (name: string) => {
    const scenarios = getScenarios()
    const scenario = scenarios[name]
    if (!scenario)
      throw new Error(
        `Unknown scenario "${name}". Known: ${Object.keys(scenarios).join(', ') || 'none'}`,
      )
    return scenario
  }

  const call = async (tool: string, ...args: unknown[]) => {
    const definition = getTools()[tool]
    if (!definition) throw new Error(`Unknown tool "${tool}"`)
    const run: ToolFn =
      typeof definition === 'function' ? definition : definition.run
    return run(...args)
  }

  return {
    'scenario.list': {
      description:
        'Setups the app defines, e.g. a signed-in user: name, description, options (a JSON Schema), active.',
      run: () =>
        Object.entries(getScenarios())
          .map(([name, s]) => ({
            name,
            description: s.description,
            options: s.options,
            active: active.has(name),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
    },
    'scenario.apply': {
      description:
        'Apply a scenario: [name, options?]. Options must fit its schema (scenario.list). Returns what it returns. Applying an active one undoes it first. bridge.restore undoes it.',
      run: async (name: string, options?: unknown) => {
        const scenario = find(name)
        // Before anything changes: a bad call leaves an active scenario as it was.
        if (scenario.options) {
          const problems = checkOptions(scenario.options, options)
          if (problems.length)
            throw new Error(
              `Scenario "${name}" got bad options, nothing was applied:\n- ${problems.join('\n- ')}\nscenario.list shows its options schema.`,
            )
        }
        const previous = await undo(name)
        if (previous.length)
          throw new Error(`Undoing the active "${name}" failed: ${previous.join('; ')}`)
        const entry: Active = { options, undos: [] }
        active.set(name, entry)
        const context: ScenarioContext = {
          options,
          call,
          onUndo: (fn) => {
            if (typeof fn !== 'function')
              throw new Error('onUndo takes a function')
            entry.undos.push(fn)
          },
        }
        try {
          return await scenario.apply(context)
        } catch (error) {
          // Take back what it did get to; its tool changes wait for bridge.restore.
          const errors = await undo(name)
          const extra = errors.length ? ` (undo: ${errors.join('; ')})` : ''
          throw new Error(`Scenario "${name}" failed: ${message(error)}${extra}`)
        }
      },
    },
    'scenario.restore': {
      pending: () => active.size > 0,
      description:
        'Undo every active scenario, newest first. bridge.restore runs this after every other restorer.',
      run: async () => {
        const names = [...active.keys()].reverse()
        const errors: string[] = []
        for (const name of names) errors.push(...(await undo(name)))
        if (errors.length) throw new Error(errors.join('; '))
        return names
      },
    },
  }
}

/** Forget every active scenario without undoing. For tests. */
export function resetScenarios(): void {
  active.clear()
}
