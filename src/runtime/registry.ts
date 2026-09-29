import type { CallMessage, ResultMessage, ToolInfo } from '../shared/protocol'
import type { LogCapture } from './logs'
import { toJson } from './to-json'
import type { ToolDefinition, ToolFn, Tools } from './types'

function unwrap(definition: ToolDefinition): {
  run: ToolFn
  description?: string
  maxArgs?: number
} {
  return typeof definition === 'function' ? { run: definition } : definition
}

/** With `logs`, each reply carries the errors recorded since the previous one. */
export function createRegistry(
  getTools: () => Tools,
  logs?: Pick<LogCapture, 'begin' | 'takeErrors'>,
) {
  const list = (): ToolInfo[] =>
    Object.entries(getTools())
      .map(([name, definition]) => ({
        name,
        description: unwrap(definition).description,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

  async function dispatch(
    call: CallMessage,
    from: string,
  ): Promise<ResultMessage> {
    const end = logs?.begin(call.tool)
    const result = await run(call, from).finally(end)
    const errors = logs?.takeErrors()
    return errors?.length ? { ...result, logs: errors } : result
  }

  async function run(call: CallMessage, from: string): Promise<ResultMessage> {
    const t0 = performance.now()
    const ms = () => Math.round((performance.now() - t0) * 100) / 100
    try {
      const definition = getTools()[call.tool]
      if (!definition) {
        const known = list()
          .map((t) => t.name)
          .join(', ')
        throw new Error(`Unknown tool "${call.tool}". Known: ${known}`)
      }
      const { run: tool, maxArgs } = unwrap(definition)
      const args = call.args ?? []
      if (maxArgs !== undefined && args.length > maxArgs)
        throw new Error(
          `${call.tool} takes at most ${maxArgs} argument${maxArgs === 1 ? '' : 's'}, got ${args.length}. A JSON array is spread into the arguments; wrap it once more to pass an array as one argument.`,
        )
      const value = await tool(...args)
      return { id: call.id, from, ok: true, value: toJson(value), ms: ms() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { id: call.id, from, ok: false, error: message, ms: ms() }
    }
  }

  return { list, dispatch }
}
