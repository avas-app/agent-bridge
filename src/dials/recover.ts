// Fast Refresh keeps a component's state when its hook calls look unchanged. `dial.*` runs hooks
// without a `use` name, so React Refresh can't see them: deleting or adding a call (what a commit
// does) leaves React with a different hook count and the screen dies. Reloading is the clean state.
const HOOK_COUNT = /Rendered (fewer|more) hooks than/
// A hook-count error this soon after start is the app's own bug (or comes back after every
// reload); leave it on screen rather than reload in a loop.
const SETTLE_MS = 5_000

type Handler = (error: unknown, isFatal?: boolean) => void
type Env = {
  console?: { error: (...args: unknown[]) => void }
  ErrorUtils?: { getGlobalHandler(): Handler; setGlobalHandler(h: Handler): void }
  expo?: { reloadAppAsync?: (reason?: string) => unknown }
}

let installed = false

export const isHookCountError = (error: unknown) =>
  HOOK_COUNT.test(String((error as { message?: unknown } | null)?.message ?? error))

/** Chains onto the global error handler once; a hook-count error reloads the app instead of leaving it white. */
export function installRefreshRecovery(
  env: Env = globalThis as Env,
  reload: () => void = defaultReload(env),
  now: () => number = Date.now,
): boolean {
  if (installed || !env.ErrorUtils) return false
  const utils = env.ErrorUtils
  const previous = utils.getGlobalHandler()
  installed = true
  const started = now()
  let scheduled = false
  const recover = () => {
    if (now() - started < SETTLE_MS) return false
    if (!scheduled) setTimeout(reload, 50)
    scheduled = true
    return true
  }
  utils.setGlobalHandler((error, isFatal) => {
    if (isHookCountError(error) && recover()) return
    previous?.(error, isFatal)
  })
  // React 19 reports an uncaught render error through console.error, not the global handler.
  const log = env.console
  if (log) {
    const original = log.error
    log.error = (...args: unknown[]) => {
      if (args.some(isHookCountError)) recover()
      return original.apply(log, args)
    }
  }
  return true
}

function defaultReload(env: Env) {
  return () => {
    // Expo's reload keeps native modules; DevSettings.reload in Expo Go loses them.
    const viaExpo = env.expo?.reloadAppAsync
    try {
      if (typeof viaExpo === 'function') return void viaExpo('agent-bridge dials: hook count changed')
      ;(require('react-native') as { DevSettings: { reload(): void } }).DevSettings.reload()
    } catch {
      // nothing else to try
    }
  }
}

export const resetRecoveryForTests = () => {
  installed = false
}
