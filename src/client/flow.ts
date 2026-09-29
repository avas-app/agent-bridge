import { type AgentBridge, AgentBridgeCallError, type LogEntry, type Timed } from './index'
import { logLine } from './log-lines'

/** A scenario a flow needs: a name, or a name with options. */
export type FlowScenario = string | { name: string; options?: unknown }

export type FlowApi = {
  bridge: AgentBridge
  call: AgentBridge['call']
  /**
   * Times one call. Arguments are spread, `step('press', 'screen.press', 'Confirm')`;
   * a single array is the whole argument list, as with `agent-bridge call`.
   */
  step: (label: string, tool: string, ...args: unknown[]) => Promise<unknown>
  /** What each declared scenario's apply returned, by name. */
  scenarios: Record<string, unknown>
}

/** A flow file: `export default async ({ step, call }) => {}`, plus what it needs. */
export type FlowModule = {
  default: (api: FlowApi) => Promise<void>
  /** Applied before the flow and undone after it, even when it fails. */
  scenario?: FlowScenario
  scenarios?: FlowScenario[]
}

export type FlowResult = {
  steps: number
  /** Errors the app logged during the flow. */
  errors: number
  /** Restorers that failed in the closing bridge.restore, with why. */
  restoreErrors: string[]
}

/** The scenarios a flow module declares, in order. */
export function flowScenarios(
  flow: Pick<FlowModule, 'scenario' | 'scenarios'>,
): Array<{ name: string; options?: unknown }> {
  const declared = [
    ...(flow.scenario === undefined ? [] : [flow.scenario]),
    ...(flow.scenarios ?? []),
  ]
  return declared.map((s) => {
    if (typeof s === 'string') return { name: s }
    if (s && typeof s === 'object' && typeof s.name === 'string') return s
    throw new Error(
      `A flow's scenario is a name or { name, options }, not ${JSON.stringify(s)}`,
    )
  })
}

/**
 * A `--scenario` value: `signedIn`, or `signedIn={"user":{"name":"Ada"}}`
 * with JSON options after the `=`.
 */
export function parseScenarioFlag(value: string): {
  name: string
  options?: unknown
} {
  const at = value.indexOf('=')
  if (at === -1) return { name: value }
  const name = value.slice(0, at)
  const raw = value.slice(at + 1)
  try {
    return { name, options: JSON.parse(raw) }
  } catch {
    throw new Error(
      `--scenario ${name}: the options after "=" must be JSON, got ${raw}`,
    )
  }
}

/** The flow's scenarios plus extra ones; an extra one replaces the flow's of the same name. */
export function mergeScenarios(
  declared: Array<{ name: string; options?: unknown }>,
  extra: Array<{ name: string; options?: unknown }>,
): Array<{ name: string; options?: unknown }> {
  const names = new Set(extra.map((s) => s.name))
  return [...declared.filter((s) => !names.has(s.name)), ...extra]
}

const failedLogs = (error: unknown): LogEntry[] =>
  error instanceof AgentBridgeCallError ? error.logs : []

export type RunFlowOptions = {
  /** Where step lines go. Default: console.log. */
  print?: (line: string) => void
  /** More scenarios to apply, e.g. from `--scenario`; one of the same name replaces the flow's. */
  scenarios?: Array<{ name: string; options?: unknown }>
}

/**
 * Runs a flow module you imported: applies its scenarios, runs it, and when
 * there were any, undoes everything with bridge.restore afterwards, even
 * when it fails. Throws what the flow threw; otherwise returns how it went.
 * It runs only the code you hand it, in this process.
 */
export async function runFlow(
  bridge: AgentBridge,
  flow: FlowModule,
  options: RunFlowOptions = {},
): Promise<FlowResult> {
  const print = options.print ?? console.log
  const needs = mergeScenarios(flowScenarios(flow), options.scenarios ?? [])
  let n = 0
  let total = 0
  let errors = 0
  const t0 = performance.now()
  const report = (logs: LogEntry[]) => {
    errors += logs.length
    for (const e of logs) print(`   ${logLine(e)}`)
  }
  // Every call the flow makes reports the errors its reply carried.
  const timed = async <T>(
    tool: string,
    ...args: unknown[]
  ): Promise<Timed<T>> => {
    try {
      const result = await bridge.timed<T>(tool, ...args)
      report(result.logs)
      return result
    } catch (error) {
      report(failedLogs(error))
      throw error
    }
  }
  const call = async <T>(tool: string, ...args: unknown[]) =>
    (await timed<T>(tool, ...args)).value
  const step = async (label: string, tool: string, ...given: unknown[]) => {
    // Same as `agent-bridge call`: one array is the argument list.
    const args = given.length === 1 && Array.isArray(given[0]) ? given[0] : given
    const { value, ms, logs } = await bridge
      .timed(tool, ...args)
      .catch((error: unknown) => {
        report(failedLogs(error))
        throw error
      })
    total += ms
    print(
      `${String(++n).padStart(2, '0')} ${label.padEnd(30)} ${ms.toFixed(1).padStart(7)} ms`,
    )
    report(logs)
    return value
  }

  const restoreErrors: string[] = []
  const applied: Record<string, unknown> = {}
  if (
    needs.length &&
    !bridge.tools().some((t) => t.name === 'scenario.apply')
  )
    throw new Error(
      `The flow needs scenario "${needs[0]!.name}", but the app defines none: pass \`scenarios\` to useAgentBridge.`,
    )
  try {
    for (const { name, options } of needs) {
      const args = options === undefined ? [name] : [name, options]
      applied[name] = await step(`scenario ${name}`, 'scenario.apply', ...args)
    }
    await flow.default({
      bridge: { ...bridge, timed, call },
      call,
      step,
      scenarios: applied,
    })
  } finally {
    if (needs.length) {
      try {
        const result = (await step('restore', 'bridge.restore')) as Record<
          string,
          unknown
        >
        for (const [name, value] of Object.entries(result ?? {})) {
          const error = (value as { error?: unknown } | null)?.error
          if (error !== undefined) restoreErrors.push(`${name}: ${String(error)}`)
        }
      } catch (error) {
        restoreErrors.push(
          `bridge.restore: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      for (const e of restoreErrors) print(`   ! restore failed: ${e}`)
    }
  }
  print(
    `${n} steps, ${total.toFixed(1)} ms in calls, ${(performance.now() - t0).toFixed(0)} ms wall (${bridge.transport})${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}`,
  )
  return { steps: n, errors, restoreErrors }
}
