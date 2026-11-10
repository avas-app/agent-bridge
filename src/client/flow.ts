import { type AgentBridge, AgentBridgeCallError, type LogEntry, type Timed } from './index'
import { logLine } from './log-lines'

/** A scenario a flow needs: a name, or a name with options. */
export type FlowScenario = string | { name: string; options?: unknown }

export type FlowApi = {
  bridge: AgentBridge
  call: AgentBridge['call']
  /**
   * Times one call. Arguments are spread, `step('press', 'screen.press', 'Confirm')`.
   * A single array is the whole argument list, as with `agent-bridge call`, so
   * to pass one array as the only argument wrap it: `step('s', 'cart.setItems', [[a, b]])`.
   * `call` does not do this: it passes its arguments as they are.
   */
  step: (label: string, tool: string, ...args: unknown[]) => Promise<unknown>
  /** What each declared scenario's apply returned, by name. */
  scenarios: Record<string, unknown>
  expect: FlowExpect
}

/** Checks that throw a readable message; each runs as a timed step. */
export type FlowExpect = {
  /** Text, label or testID is on screen (waits up to `timeoutMs`, default 5000). */
  text: (target: string, options?: { timeoutMs?: number }) => Promise<void>
  /** The target is not on screen (waits for it to leave). */
  gone: (target: string, options?: { timeoutMs?: number }) => Promise<void>
  /** `router.current` has this pathname (waits up to `timeoutMs`, default 2000). */
  route: (pathname: string, options?: { timeoutMs?: number }) => Promise<void>
  /** A tool's result contains `match`: objects by the keys given, arrays and values exactly. */
  result: (tool: string, args: unknown[], match: unknown) => Promise<void>
}

/** A flow file: `export default async ({ step, call }) => {}`, plus what it needs. */
export type FlowModule = {
  /** Shown in the run summary and matched by `--grep`; default: the file name. */
  name?: string
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
  /** "app reloaded; N pending restores lost" warnings seen during the flow. */
  notices: string[]
}

/** What was on screen when a flow failed. */
export type FailureState = { screen?: string[]; route?: unknown }

/** Whether `actual` holds everything in `expected`: objects by the keys given, arrays and values exactly. */
export function deepMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((e, i) => deepMatches(actual[i], e))
    )
  if (expected && typeof expected === 'object')
    return (
      !!actual &&
      typeof actual === 'object' &&
      Object.entries(expected).every(([k, v]) =>
        deepMatches((actual as Record<string, unknown>)[k], v),
      )
    )
  return Object.is(actual, expected)
}

const MAX_SCREEN_LINES = 40

/** One line per element of a `screen.snapshot` result, capped. */
export function compactScreen(snapshot: unknown): string[] {
  const elements = (snapshot as { elements?: unknown[] } | null)?.elements
  if (!Array.isArray(elements)) return []
  const lines = elements.slice(0, MAX_SCREEN_LINES).map((raw) => {
    const e = raw as Record<string, unknown>
    const parts = [String(e.kind ?? 'element')]
    if (e.testID) parts.push(`#${String(e.testID)}`)
    for (const key of ['text', 'label', 'placeholder', 'value'])
      if (typeof e[key] === 'string' && e[key]) parts.push(JSON.stringify(e[key]))
    if (e.disabled) parts.push('disabled')
    if (e.checked) parts.push(`checked=${String(e.checked)}`)
    return parts.join(' ')
  })
  if (elements.length > MAX_SCREEN_LINES)
    lines.push(`... ${elements.length - MAX_SCREEN_LINES} more`)
  return lines
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

const failedNotice = (error: unknown) =>
  error instanceof AgentBridgeCallError ? error.notice : undefined

export type RunFlowOptions = {
  /** Where step lines go. Default: console.log. */
  print?: (line: string) => void
  /** More scenarios to apply, e.g. from `--scenario`; one of the same name replaces the flow's. */
  scenarios?: Array<{ name: string; options?: unknown }>
  /** Leave the app as the flow left it: no closing bridge.restore (for debugging). */
  keep?: boolean
  /** Called with what was on screen when the flow failed. */
  onFailure?: (state: FailureState) => void
  /** Called once the flow and its restore are done, also when it failed. */
  onFinish?: (result: FlowResult) => void
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
  const notices: string[] = []
  const report = (logs: LogEntry[], notice?: string) => {
    errors += logs.length
    for (const e of logs) print(`   ${logLine(e)}`)
    if (notice) {
      notices.push(notice)
      print(`   ! ${notice}`)
    }
  }
  // Every call the flow makes reports the errors its reply carried.
  const timed = async <T>(
    tool: string,
    ...args: unknown[]
  ): Promise<Timed<T>> => {
    try {
      const result = await bridge.timed<T>(tool, ...args)
      report(result.logs, result.notice)
      return result
    } catch (error) {
      report(failedLogs(error), failedNotice(error))
      throw error
    }
  }
  const call = async <T>(tool: string, ...args: unknown[]) =>
    (await timed<T>(tool, ...args)).value
  const step = async (label: string, tool: string, ...given: unknown[]) => {
    // Same as `agent-bridge call`: one array is the argument list.
    const args = given.length === 1 && Array.isArray(given[0]) ? given[0] : given
    const { value, ms, logs, notice } = await bridge
      .timed(tool, ...args)
      .catch((error: unknown) => {
        report(failedLogs(error), failedNotice(error))
        throw error
      })
    total += ms
    print(
      `${String(++n).padStart(2, '0')} ${label.padEnd(30)} ${ms.toFixed(1).padStart(7)} ms`,
    )
    report(logs, notice)
    return value
  }

  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error)
  const expectApi: FlowExpect = {
    text: async (target, o) => {
      await step(`expect text ${JSON.stringify(target)}`, 'screen.waitFor', target, o ?? {}).catch(
        (error: unknown) => {
          throw new Error(`expected ${JSON.stringify(target)} on screen: ${message(error)}`)
        },
      )
    },
    gone: async (target, o) => {
      await step(`expect gone ${JSON.stringify(target)}`, 'screen.waitFor', target, {
        ...o,
        gone: true,
      }).catch((error: unknown) => {
        throw new Error(`expected ${JSON.stringify(target)} to be off screen: ${message(error)}`)
      })
    },
    route: async (pathname, o) => {
      const deadline = performance.now() + (o?.timeoutMs ?? 2000)
      for (;;) {
        const route = (await step(`expect route ${pathname}`, 'router.current')) as {
          pathname?: string
        } | null
        if (route?.pathname === pathname) return
        if (performance.now() >= deadline)
          throw new Error(`expected route ${pathname}, got ${route?.pathname ?? JSON.stringify(route)}`)
        await new Promise((r) => setTimeout(r, 50))
      }
    },
    result: async (tool, args, match) => {
      const value = await step(`expect ${tool}`, tool, args)
      if (!deepMatches(value, match))
        throw new Error(
          `expected ${tool} to match ${JSON.stringify(match)}, got ${JSON.stringify(value)}`,
        )
    },
  }
  // The app may be gone or reloading, so every read here is best effort.
  const failureState = async (): Promise<FailureState> => {
    const has = (name: string) => bridge.tools().some((t) => t.name === name)
    const state: FailureState = {}
    if (has('screen.snapshot'))
      state.screen = await bridge
        .call('screen.snapshot')
        .then(compactScreen)
        .catch(() => undefined)
    if (has('router.current'))
      state.route = await bridge.call('router.current').catch(() => undefined)
    return state
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
      expect: expectApi,
    })
  } catch (error) {
    const state = await failureState()
    if (state.route !== undefined) print(`   route: ${JSON.stringify(state.route)}`)
    if (state.screen?.length) {
      print('   on screen:')
      for (const line of state.screen) print(`     ${line}`)
    }
    options.onFailure?.(state)
    throw error
  } finally {
    if (!options.keep && (needs.length || bridge.tools().some((t) => t.name === 'bridge.restore'))) {
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
    options.onFinish?.({ steps: n, errors, restoreErrors, notices })
  }
  print(
    `${n} steps, ${total.toFixed(1)} ms in calls, ${(performance.now() - t0).toFixed(0)} ms wall (${bridge.transport})${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}${notices.length ? ', the app reloaded' : ''}`,
  )
  return { steps: n, errors, restoreErrors, notices }
}

export type FlowEntry = { file: string; name: string; module: FlowModule }

export type FlowRun = {
  file: string
  name: string
  status: 'passed' | 'failed' | 'skipped'
  ms: number
  steps: number
  errors: number
  /** Why it failed: what the flow threw, restore failures, or app errors under `strict`. */
  error?: string
  state?: FailureState
  restoreErrors: string[]
  notices: string[]
}

export type RunFlowsOptions = RunFlowOptions & {
  /** Stop at the first failure; the rest are reported as skipped. */
  bail?: boolean
  /** Count an error the app logged as a failure. */
  strict?: boolean
}

/** Runs flows in order on one connection, each followed by a restore (see `keep`), and never throws for a failing flow. */
export async function runFlows(
  bridge: AgentBridge,
  entries: FlowEntry[],
  options: RunFlowsOptions = {},
): Promise<FlowRun[]> {
  const print = options.print ?? console.log
  const runs: FlowRun[] = []
  let unreachable = false
  for (const entry of entries) {
    const skipped = unreachable || (options.bail && runs.some((r) => r.status === 'failed'))
    const base = { file: entry.file, name: entry.name, restoreErrors: [], notices: [] }
    if (skipped) {
      runs.push({ ...base, status: 'skipped', ms: 0, steps: 0, errors: 0 })
      continue
    }
    print(`\n${entry.name}`)
    const t0 = performance.now()
    let state: FailureState | undefined
    let done: FlowResult = { steps: 0, errors: 0, restoreErrors: [], notices: [] }
    const reasons: string[] = []
    try {
      await runFlow(bridge, entry.module, {
        ...options,
        onFailure: (s) => {
          state = s
        },
        onFinish: (r) => {
          done = r
        },
      })
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      print(`   FAILED: ${why}`)
      reasons.push(why)
    }
    if (done.restoreErrors.length) reasons.push(`restore failed: ${done.restoreErrors.join('; ')}`)
    if (options.strict && done.errors)
      reasons.push(`the app logged ${done.errors} error${done.errors === 1 ? '' : 's'}`)
    if (done.notices.length)
      print('   ! the app reloaded: changes made before the reload could not be undone')
    runs.push({
      ...base,
      ...done,
      status: reasons.length ? 'failed' : 'passed',
      ms: performance.now() - t0,
      ...(reasons.length && { error: reasons.join('; ') }),
      ...(state && { state }),
    })
    // The restore call itself failed: the app is unreachable, so don't wait out a timeout per flow.
    if (done.restoreErrors.some((e) => e.startsWith('bridge.restore:'))) unreachable = true
  }
  return runs
}
