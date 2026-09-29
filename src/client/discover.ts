export const DEFAULT_METRO = 'localhost:8081'

const stripScheme = (metro: string) =>
  metro.replace(/^https?:\/\//, '').replace(/\/+$/, '')

/** The Metro given by flag or env, or undefined: session matching only uses what was asked for. */
export function explicitMetro(metro?: string): string | undefined {
  const given = metro ?? process.env.AGENT_BRIDGE_METRO
  return given ? stripScheme(given) : undefined
}

export function metroHost(metro?: string): string {
  return stripScheme(metro ?? process.env.AGENT_BRIDGE_METRO ?? DEFAULT_METRO)
}

/**
 * The host Expo's dev server advertises (e.g. "buildbox:8123"). Expo drops any
 * debugger socket whose Origin doesn't match it exactly, silently. Returns null
 * for bare React Native.
 */
export async function expoHostUri(metro: string): Promise<string | null> {
  try {
    const res = await fetch(`http://${metro}/`, {
      headers: {
        'expo-platform': 'ios',
        accept: 'application/expo+json,application/json',
      },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    const manifest = (await res.json()) as {
      hostUri?: string
      extra?: {
        expoClient?: { hostUri?: string }
        expoGo?: { debuggerHost?: string }
      }
    }
    return (
      manifest.extra?.expoClient?.hostUri ??
      manifest.extra?.expoGo?.debuggerHost ??
      manifest.hostUri ??
      null
    )
  } catch {
    return null
  }
}

export type CdpTarget = {
  id: string
  title: string
  appId?: string
  deviceName?: string
  webSocketDebuggerUrl: string
}

export async function listCdpTargets(metro: string): Promise<CdpTarget[]> {
  const res = await fetch(`http://${metro}/json/list`, {
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok)
    throw new Error(
      `Metro at ${metro} answered /json/list with HTTP ${res.status}`,
    )
  return (await res.json()) as CdpTarget[]
}

/** One item matching `filter`, or an error that lists what is connected. */
export function pickOne<T>(
  items: T[],
  filter: string | undefined,
  label: (item: T) => string,
): T {
  const matching = filter
    ? items.filter((item) =>
        label(item).toLowerCase().includes(filter.toLowerCase()),
      )
    : items
  const connected = items.map(label).join('; ') || 'none'
  if (matching.length === 0) {
    throw new Error(
      filter
        ? `No app matches "${filter}". Connected: ${connected}`
        : 'No app is connected to Metro.',
    )
  }
  if (matching.length > 1 && !filter) {
    throw new Error(
      `${matching.length} apps are connected; pick one with --device. Connected: ${connected}`,
    )
  }
  return matching[0] as T
}
