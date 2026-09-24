import type { CallMessage, ResultMessage, ToolInfo } from '../shared/protocol'
import { toJson } from './to-json'
import type { ToolDefinition, ToolFn, Tools } from './types'

function unwrap(definition: ToolDefinition): {
  run: ToolFn
  description?: string
} {
  return typeof definition === 'function' ? { run: definition } : definition
}

export function createRegistry(getTools: () => Tools) {
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
      const value = await unwrap(definition).run(...(call.args ?? []))
      return { id: call.id, from, ok: true, value: toJson(value), ms: ms() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { id: call.id, from, ok: false, error: message, ms: ms() }
    }
  }

  return { list, dispatch }
}
