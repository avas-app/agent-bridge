import type { CallMessage, ResultMessage, ToolInfo } from '../shared/protocol'
import type { LogCapture } from './logs'
import { toJson } from './to-json'
import { INTERNAL_TOOLS, journalByArea, journalRev, pendingByArea } from './tools/restore'
import type { ToolDefinition, ToolFn, Tools } from './types'

/** Holds the key of the session that owns this load's journal. */
export type KeySlot = { key?: string }

// Module level, like loadId: Fast Refresh rebuilds the registry but must not reopen the slot.
// Not access control: it only stops a second session on the same app from taking the first one's journal.
const loadSlot: KeySlot = {}

/** For tests: forget the session key, as a fresh load would. */
export function resetSessionKey() {
  loadSlot.key = undefined
}

/** True for the first non-empty key the slot has seen, and for that same key afterwards. */
function ownsKey(slot: KeySlot, key: unknown): boolean {
  if (typeof key !== 'string' || key === '') return false
  slot.key ??= key
  return slot.key === key
}

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
  loadId?: string,
  keySlot: KeySlot = loadSlot,
) {
  const list = (): ToolInfo[] =>
    Object.entries(getTools())
      .filter(([name]) => !INTERNAL_TOOLS.includes(name))
      .map(([name, definition]) => ({
        name,
        description: unwrap(definition).description,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

  async function dispatch(
    call: CallMessage,
    from: string,
  ): Promise<ResultMessage> {
    // The client's health ping and pending check must not take errors meant for the next real call.
    const quiet = call.tool === 'bridge.ping' || call.tool === 'bridge.pending'
    const trusted = ownsKey(keySlot, call.journalKey)
    const end = quiet ? undefined : logs?.begin(call.tool)
    const result = INTERNAL_TOOLS.includes(call.tool) && !trusted
      ? await refused(call, from)
      : await run(call, from).finally(end)
    const errors = quiet ? undefined : logs?.takeErrors()
    const stamped = loadId ? { ...result, loadId, ...pending(), ...journal(call, trusted) } : result
    return errors?.length ? { ...stamped, logs: errors } : stamped
  }

  // After the tool ran, so a reply shows the state it left behind.
  function pending(): { pending?: string[] } {
    const areas = Object.keys(pendingByArea(getTools()))
    return areas.length ? { pending: areas } : {}
  }

  function journal(call: CallMessage, trusted: boolean) {
    const rev = journalRev(getTools())
    const out: { journal?: number; journalData?: Record<string, unknown> } = rev ? { journal: rev } : {}
    if (trusted && call.journalAck !== undefined && call.journalAck !== `${loadId}:${rev}`)
      out.journalData = journalByArea(getTools())
    return out
  }

  const refused = (call: CallMessage, from: string): ResultMessage => ({
    id: call.id,
    from,
    ok: false,
    error: `${call.tool} is for a session's own use`,
    ms: 0,
  })

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
