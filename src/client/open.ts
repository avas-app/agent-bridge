import { connectCdp } from './cdp'
import type { Connection, TransportName } from './connection'
import { metroHost } from './discover'
import { connectExpo } from './expo'

export type OpenOptions = {
  metro?: string
  device?: string
  transport?: 'auto' | TransportName
}

/** A raw connection to one app: Expo's socket first, then CDP, unless forced. */
export async function openConnection(
  options: OpenOptions = {},
): Promise<Connection> {
  const metro = metroHost(options.metro)
  const want = options.transport ?? 'auto'
  let expoError: unknown
  if (want !== 'cdp') {
    try {
      return await connectExpo(metro, options.device)
    } catch (error) {
      if (want === 'expo') throw error
      expoError = error
    }
  }
  try {
    return await connectCdp(metro, options.device)
  } catch (error) {
    const expoNote = expoError ? ` (Expo socket: ${String(expoError)})` : ''
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${expoNote}`,
    )
  }
}
