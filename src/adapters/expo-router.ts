import type { Tools } from '../runtime/types'

// `href` is `never` so any router fits: with typed routes on, expo-router
// narrows `Href` to a union of paths and objects, which `string` is not
// assignable to either way. The agent sends a string; expo-router validates it.
/** The imperative `router` from expo-router. Passed in, so this adds no dependency. */
export type RouterLike = {
  navigate(href: never): void
  push(href: never): void
  replace(href: never): void
  back(): void
  canGoBack(): boolean
}

/** The root navigation container, from `useNavigationContainerRef()` in expo-router. */
export type NavigationLike = {
  getRootState(): unknown
  isReady?(): boolean
  addListener?(type: '__unsafe_action__', callback: () => void): () => void
}

export type RouterToolsOptions = {
  /** Enables `router.current`, and makes navigation tools return once the route has changed. */
  navigation?: NavigationLike
}

/** Where the app is, as expo-router's `usePathname`, `useSegments` and `useGlobalSearchParams` would say. */
export type CurrentRoute = {
  pathname: string
  /** `pathname` plus the params that are not part of the path, e.g. `/inbox?filter=unread`. */
  href: string
  params: Record<string, string | string[]>
  segments: string[]
  /** The focused route's name in its navigator, e.g. `index` or `[id]`. */
  name: string
  canGoBack: boolean
}

type StateLike = {
  index?: number
  routes: { name: string; params?: Record<string, unknown>; path?: string; state?: StateLike }[]
}

type ParamValue = string | string[]

// expo-router wraps the app in one `__root` route; only `+not-found` and
// `_sitemap` sit beside it.
const ROOT = '__root'
const NOT_FOUND = '+not-found'

// If nothing reaches the navigation container (an unknown href, or it has not
// mounted), a navigation tool gives up waiting after this long.
const SETTLE_MS = 1000

const decode = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const isGroup = (segment: string) => segment.startsWith('(') && segment.endsWith(')')

const focused = (state: StateLike) => state.routes[state.index ?? 0]

/**
 * Route info from the live navigation state. Mirrors expo-router 57's
 * internal `getRouteInfoFromState`, which it does not export.
 */
function routeFromState(state: StateLike | undefined): Omit<CurrentRoute, 'canGoBack'> {
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
function settle(navigation: NavigationLike, go: () => void): Promise<void> {
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

/**
 * Navigate without taps. Pass `router` from `expo-router`, and
 * `{ navigation: useNavigationContainerRef() }` to read the current route.
 */
export function routerTools(router: RouterLike, options: RouterToolsOptions = {}): Tools {
  const { navigation } = options
  const go = (fn: () => void, value: unknown) =>
    navigation ? settle(navigation, fn).then(() => value) : (fn(), value)

  return {
    'router.navigate': {
      description: 'Go to a route, reusing it if it is already in the stack.',
      run: (href: string) => go(() => router.navigate(href as never), href),
    },
    'router.push': {
      description: 'Push a route.',
      run: (href: string) => go(() => router.push(href as never), href),
    },
    'router.replace': {
      description: 'Replace the current route.',
      run: (href: string) => go(() => router.replace(href as never), href),
    },
    'router.back': {
      description: 'Go back if possible. Returns whether it could.',
      run: () => {
        const could = router.canGoBack()
        return could ? go(() => router.back(), true) : false
      },
    },
    'router.current': {
      description: 'The current route: pathname, href, params, segments, name, canGoBack.',
      run: (): CurrentRoute => {
        if (!navigation)
          throw new Error(
            'router.current needs the navigation container. Pass it: routerTools(router, { navigation: useNavigationContainerRef() }) with useNavigationContainerRef from expo-router.',
          )
        if (navigation.isReady && !navigation.isReady())
          throw new Error('The navigation container has not mounted yet.')
        const state = navigation.getRootState() as StateLike | undefined
        return { ...routeFromState(state), canGoBack: router.canGoBack() }
      },
    },
  }
}
