import { spawn } from 'node:child_process'

import type { AgentBridge } from './index'

export const ACTIVITY_ENV = 'AGENT_BRIDGE_ON_ACTIVITY'
const EVERY_MS = 60_000
const KILL_AFTER_MS = 30_000

export type ActivityHook = {
  /** Called after each tool call; runs the command at most once per minute. */
  ran: (tool: string) => void
}

export type ActivityHookOptions = {
  /** Shell command. Default: $AGENT_BRIDGE_ON_ACTIVITY; none means no hook. */
  command?: string
  /** The project directory the command runs in. */
  cwd: string
  /** Where the first failure is reported, once. */
  report: (text: string) => void
  now?: () => number
}

/** A hook for the command in `options` or the environment, or undefined when there is none. */
export function createActivityHook(
  options: ActivityHookOptions,
): ActivityHook | undefined {
  const command = (options.command ?? process.env[ACTIVITY_ENV])?.trim()
  if (!command) return undefined
  const now = options.now ?? Date.now
  let last = -Infinity
  let reported = false
  const fail = (why: string) => {
    if (reported) return
    reported = true
    options.report(`on-activity command "${command}" ${why}`)
  }
  return {
    ran: (tool) => {
      // The session's own health check isn't the agent working.
      if (tool === 'bridge.ping') return
      const t = now()
      if (t - last < EVERY_MS) return
      last = t
      try {
        const child = spawn(command, {
          shell: true,
          cwd: options.cwd,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        const kill = setTimeout(() => child.kill(), KILL_AFTER_MS)
        ;(kill as { unref?: () => void }).unref?.()
        child.on('error', (error) => {
          clearTimeout(kill)
          fail(`failed: ${error.message}`)
        })
        child.on('exit', (code, signal) => {
          clearTimeout(kill)
          if (code) fail(`exited with code ${code}`)
          else if (signal) fail(`was stopped by ${signal}`)
        })
        child.unref()
      } catch (error) {
        fail(`failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/** `bridge` that runs `hook` after each tool call, whether it worked or not. */
export function withActivityHook<T extends AgentBridge>(
  bridge: T,
  hook: ActivityHook | undefined,
): T {
  if (!hook) return bridge
  const timed = async <V>(tool: string, ...args: unknown[]) => {
    try {
      return await bridge.timed<V>(tool, ...args)
    } finally {
      hook.ran(tool)
    }
  }
  return {
    ...bridge,
    timed,
    call: async <V>(tool: string, ...args: unknown[]) =>
      (await timed<V>(tool, ...args)).value,
  }
}
