import type { CurrentRoute, NavigationLike } from './expo-router'

export type StateLike = {
  index?: number
  routes: { name: string; params?: Record<string, unknown>; path?: string; state?: StateLike }[]
}

export type ParamValue = string | string[]

// expo-router wraps the app in one `__root` route; only `+not-found` and
// `_sitemap` sit beside it.
export const ROOT = '__root'
export const NOT_FOUND = '+not-found'

// If nothing reaches the navigation container (an unknown href, or it has not
// mounted), a navigation tool gives up waiting after this long.
const SETTLE_MS = 1000

export const decode = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export const isGroup = (segment: string) => segment.startsWith('(') && segment.endsWith(')')

const focused = (state: StateLike) => state.routes[state.index ?? 0]

/**
 * Route info from the live navigation state. Mirrors expo-router 57's
 * internal `getRouteInfoFromState`, which it does not export.
 */
export function routeFromState(state: StateLike | undefined): Omit<CurrentRoute, 'canGoBack'> {
  let route = state && focused(state)
  if (!route) return { pathname: '/', href: '/', params: {}, segments: [], name: '' }
  if (route.name !== ROOT) {
    const path = route.path ?? (route.name === NOT_FOUND ? '/' : `/${route.name}`)
    return { pathname: path, href: path, params: {}, segments: [route.name], name: route.name }
  }

  const segments: string[] = []
  const raw: Record<string, unknown> = {}
  let name = ''
  let next = route.state
  while (next && (route = focused(next))) {
    Object.assign(raw, route.params)
    name = route.name
    segments.push(...route.name.replace(/^\//, '').split('/'))
    next = route.state
  }
  // A navigator that has not rendered yet keeps the rest of the path in params.
  let pending = route?.params
  while (pending && typeof pending.screen === 'string') {
    segments.push(...pending.screen.replace(/^\//, '').split('/'))
    name = pending.screen
    pending = pending.params && typeof pending.params === 'object'
      ? (pending.params as Record<string, unknown>)
      : undefined
  }
  if (segments.at(-1) === 'index') segments.pop()
  delete raw.screen
  delete raw.params

  const params: Record<string, ParamValue> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') params[key] = decode(value)
    else if (Array.isArray(value)) params[key] = value.map((v) => decode(String(v)))
    else if (value != null) params[key] = String(value)
  }

  const inPath = new Set<string>()
  const fill = (key: string): string[] => {
    inPath.add(key)
    const value = params[key]
    return value === undefined ? [] : Array.isArray(value) ? value : [value]
  }
  const pathname =
    '/' +
    segments
      .filter((s) => !isGroup(s))
      .flatMap((s) => {
        if (s === NOT_FOUND) return fill('not-found')
        if (s.startsWith('[...') && s.endsWith(']')) return fill(s.slice(4, -1).replace(/\?$/, ''))
        if (s.startsWith('[') && s.endsWith(']')) return fill(s.slice(1, -1))
        return [s]
      })
      .join('/')

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params))
    if (!inPath.has(key)) for (const v of [value].flat()) search.append(key, v)
  const query = search.toString()
  return { pathname, href: query ? `${pathname}?${query}` : pathname, params, segments, name }
}

// router.navigate only queues the action; expo-router dispatches it from an
// effect after the next render. The container applies an action synchronously
// right after announcing it, so once it is announced a read sees the new route.
export function settle(navigation: NavigationLike, go: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let off: (() => void) | undefined
    const done = () => {
      off?.()
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, navigation.addListener ? SETTLE_MS : 0)
    off = navigation.addListener?.('__unsafe_action__', done)
    try {
      go()
    } catch (error) {
      off?.()
      clearTimeout(timer)
      reject(error)
    }
  })
}

