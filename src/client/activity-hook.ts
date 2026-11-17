import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'

import type { AgentBridge } from './index'

export const ACTIVITY_ENV = 'AGENT_BRIDGE_ON_ACTIVITY'
const EVERY_MS = 60_000
const KILL_AFTER_MS = 30_000

// Runs the command in a group of its own and ends the whole group on a timeout.
// It outlives a one-off CLI call, so the stop and the failure marker still happen.
const RUNNER = `
const { spawn, spawnSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')
const e = process.env
const note = (why) => {
  if (!e.AB_HOOK_MARKER) return
  try { appendFileSync(e.AB_HOOK_MARKER, 'on-activity command "' + e.AB_HOOK_COMMAND + '" ' + why + '\\n') } catch {}
}
const child = spawn(e.AB_HOOK_COMMAND, { shell: true, cwd: e.AB_HOOK_CWD, stdio: 'ignore', windowsHide: true })
const timer = setTimeout(() => {
  note('ran longer than ' + e.AB_HOOK_MS / 1000 + ' s and was stopped')
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(process.pid), '/T', '/F'], { stdio: 'ignore' })
  else process.kill(-process.pid, 'SIGKILL')
}, Number(e.AB_HOOK_MS))
child.on('error', (error) => { note('failed: ' + error.message); process.exit(127) })
child.on('exit', (code, signal) => {
  clearTimeout(timer)
  if (code) note('exited with code ' + code)
  else if (signal) note('was stopped by ' + signal)
  process.exit(code || (signal ? 1 : 0))
})
`

export type ActivityHook = {
  /** Called after each tool call; runs the command at most once per minute. */
  ran: (tool: string) => void
}

export type ActivityHookOptions = {
  /** Shell command. Default: $AGENT_BRIDGE_ON_ACTIVITY; none means no hook. */
  command?: string
  /** Fall back to $AGENT_BRIDGE_ON_ACTIVITY when there is no command. Default true. */
  useEnv?: boolean
  /** The project directory the command runs in. */
  cwd: string
  /** Where the first failure is reported, once. */
  report: (text: string) => void
  now?: () => number
  /** Stop the command after this long. Default 30 s. */
  killAfterMs?: number
  /**
   * A file for failures that outlive this process (one-off calls exit before
   * the command ends). Its content is reported now and the file removed.
   */
  marker?: string
}

/** A hook for the command in `options` or the environment, or undefined when there is none. */
export function createActivityHook(
  options: ActivityHookOptions,
): ActivityHook | undefined {
  const command = (
    options.command ??
    (options.useEnv === false ? undefined : process.env[ACTIVITY_ENV])
  )?.trim()
  if (!command) return undefined
  const now = options.now ?? Date.now
  let last = -Infinity
  let reported = false
  const marker = options.marker
  if (marker && existsSync(marker)) {
    try {
      const earlier = readFileSync(marker, 'utf8').split('\n')[0]
      if (earlier) options.report(`${earlier} (on an earlier call)`)
    } catch {}
    rmSync(marker, { force: true })
  }
  const killAfter = options.killAfterMs ?? KILL_AFTER_MS
  const fail = (why: string) => {
    if (marker) rmSync(marker, { force: true })
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
        if (!existsSync(options.cwd))
          return fail(`failed: ${options.cwd} doesn't exist`)
        // The command goes by environment, not argv, so `ps` doesn't show it.
        const child = spawn(process.execPath, ['-e', RUNNER], {
          cwd: options.cwd,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: {
            ...process.env,
            AB_HOOK_COMMAND: command,
            AB_HOOK_CWD: options.cwd,
            AB_HOOK_MS: String(killAfter),
            AB_HOOK_MARKER: marker ?? '',
          },
        })
        child.on('error', (error) => fail(`failed: ${error.message}`))
        child.on('exit', (code, signal) => {
          if (signal === 'SIGKILL' || code === 137)
            fail(`ran longer than ${killAfter / 1000} s and was stopped`)
          else if (code) fail(`exited with code ${code}`)
          else if (signal) fail(`was stopped by ${signal}`)
          else if (marker) rmSync(marker, { force: true })
        })
        child.unref()
      } catch (error) {
        fail(`failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/** The warning for a client whose session has no hook while the variable is set, else undefined. */
export function sessionHookWarning(
  session: { name: string; hook?: boolean },
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (session.hook || flag?.trim() || !env[ACTIVITY_ENV]?.trim()) return undefined
  return `${ACTIVITY_ENV} is set, but session "${session.name}" was started without an activity hook, so nothing runs. Stop it (agent-bridge session stop --session ${session.name}) and start it again with the variable set.`
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
