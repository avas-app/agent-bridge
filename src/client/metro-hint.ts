// Runs only after a connection failed: look for Metro on the ports agents
// usually pick and say where it is. Never connects there (#69).
import { listSessions } from './session/state'

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** Where to look. Tests point `ports` at their own servers. */
export const probe = {
  ports: [...range(8081, 8090), ...range(8100, 8199)],
  eachMs: 300,
  totalMs: 1000,
}

export type FoundMetro = { metro: string; apps: string[] }

const hostOf = (metro: string) => {
  const colon = metro.lastIndexOf(':')
  return colon > 0 && !metro.endsWith(']') ? metro.slice(0, colon) : metro
}

async function answers(metro: string, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`http://${metro}/status`, { signal })
    return (await res.text()).includes('packager-status:running')
  } catch {
    return false
  }
}

async function appsOn(metro: string, signal: AbortSignal): Promise<string[]> {
  try {
    const res = await fetch(`http://${metro}/json/list`, { signal })
    const targets = (await res.json()) as Array<{
      title?: string
      deviceName?: string
    }>
    const names = targets.map(
      (t) => `${t.title ?? '?'}${t.deviceName ? ` [${t.deviceName}]` : ''}`,
    )
    return [...new Set(names)]
  } catch {
    return []
  }
}

/** Metro servers on `metro`'s host and the ports of running sessions, other than `metro` itself. */
export async function findMetros(metro: string): Promise<FoundMetro[]> {
  const host = hostOf(metro)
  const candidates = new Set(probe.ports.map((port) => `${host}:${port}`))
  try {
    for (const s of listSessions()) candidates.add(s.metro)
  } catch {}
  candidates.delete(metro)
  const deadline = AbortSignal.timeout(probe.totalMs)
  const within = () =>
    AbortSignal.any([deadline, AbortSignal.timeout(probe.eachMs)])
  const running = (
    await Promise.all(
      [...candidates].map(async (m) => ((await answers(m, within())) ? m : null)),
    )
  ).filter((m): m is string => m !== null)
  return Promise.all(
    running.map(async (m) => ({ metro: m, apps: await appsOn(m, within()) })),
  )
}

const label = (found: FoundMetro) =>
  `${found.metro} (${
    found.apps.length
      ? `${found.apps.length === 1 ? 'app' : 'apps'}: ${found.apps.join(', ')}`
      : 'no app connected'
  })`

const howToSet = (metro: string) =>
  `Pass --metro ${metro} or set AGENT_BRIDGE_METRO=${metro}.`

function elsewhere(found: FoundMetro[]): string {
  const [only] = found
  if (found.length === 1 && only)
    return `Metro is running on ${label(only)}. ${howToSet(only.metro)}`
  return `Metro is running on ${found.map(label).join('; ')}. ${howToSet('<host:port>')}`
}

const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const code = (error as NodeJS.ErrnoException).code ?? ''
  return `${error.message} ${code} ${error.cause ? errorText(error.cause) : ''}`
}

/** Node says ECONNREFUSED, bun ConnectionRefused. */
export const isRefused = (error: unknown) =>
  /ECONNREFUSED|ConnectionRefused/.test(errorText(error))

const NO_APP = /No app is connected to Metro|No app matches/

/** The message for "nothing listens on `metro`", naming any Metro found nearby. */
export async function refusedMessage(metro: string): Promise<string> {
  const found = await findMetros(metro)
  if (found.length)
    return `Nothing is listening on ${metro}. ${elsewhere(found)}`
  const host = hostOf(metro)
  return `Nothing is listening on ${metro}, and no Metro answered on ${host} ports 8081-8090 or 8100-8199. Start Metro, or if it runs elsewhere, pass --metro <host:port> or set AGENT_BRIDGE_METRO=<host:port>.`
}

/** The line added under "no app": likely causes, and other Metro servers that have apps. */
export async function noAppHint(metro: string, device?: string): Promise<string> {
  const causes = `Likely: the app isn't open or hasn't reloaded since the bridge was mounted, it uses another Metro${device ? `, or --device "${device}" doesn't match` : ''}.`
  const withApps = (await findMetros(metro)).filter((f) => f.apps.length)
  return withApps.length ? `${causes} ${elsewhere(withApps)}` : causes
}

/** Whether nothing listens on `metro`: one short request, made only after a failure. */
async function refused(metro: string): Promise<boolean> {
  try {
    await fetch(`http://${metro}/status`, {
      signal: AbortSignal.timeout(probe.eachMs),
    })
    return false
  } catch (error) {
    return isRefused(error)
  }
}

/**
 * A failed connect, explained: a refused connection becomes where Metro is,
 * and "no app" gains its likely causes. Other errors pass through.
 */
export async function explainConnectError(
  error: unknown,
  metro: string,
  device?: string,
): Promise<unknown> {
  const message = error instanceof Error ? error.message : String(error)
  if (NO_APP.test(message))
    return new Error(`${message}\n${await noAppHint(metro, device)}`, {
      cause: error,
    })
  // Asked again rather than read from `error`: bun's ws only says "Failed to connect".
  if (await refused(metro))
    return new Error(await refusedMessage(metro), { cause: error })
  return error
}

/** For an empty device list: throws the refused message if nothing listens on `metro`. */
export async function assertListening(metro: string): Promise<void> {
  if (await refused(metro)) throw new Error(await refusedMessage(metro))
}
