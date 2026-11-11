import { settle as settleScreen } from '../runtime/screen/settle'
import type { Tools } from '../runtime/types'

/** The container ref from `createNavigationContainerRef()` or `useNavigationContainerRef()`. Passed in, so this adds no dependency. */
export type NavigationRefLike = {
  getRootState(): unknown
  isReady(): boolean
  canGoBack(): boolean
  // `never` params: the ref's `navigate` is typed per app's route list.
  navigate(...args: never[]): void
  goBack(): void
  dispatch(action: never): void
  addListener?(type: 'state', callback: () => void): () => void
}

type StateLike = {
  index?: number
  routeNames?: string[]
  routes: { name: string; params?: Record<string, unknown>; state?: StateLike }[]
}

type GetStateFromPath = (path: string, config?: never) => StateLike | undefined

export type NavToolsOptions = {
  /** Your `linking` object; its `config` is how a path like `/post/7` is matched to a screen. */
  linking?: { config?: unknown; getStateFromPath?: GetStateFromPath }
  /** `getStateFromPath` from `@react-navigation/native`, to let the tools take paths. */
  getStateFromPath?: GetStateFromPath
}

/** Where the app is. */
export type CurrentRoute = {
  /** The focused screen's name. */
  name: string
  params?: Record<string, unknown>
  /** Names from the root navigator down to the focused screen, e.g. `['Main', 'Post']`. */
  path: string[]
  /** The screens in the focused navigator, bottom first. */
  stack: { name: string; params?: Record<string, unknown> }[]
  canGoBack: boolean
}

// If the container never announces a change (the app was already there, or the
// action found no screen), a navigation tool gives up waiting after this long.
const SETTLE_MS = 500

const focused = (state: StateLike) => state.routes[state.index ?? state.routes.length - 1]

function read(nav: NavigationRefLike): CurrentRoute {
  if (!nav.isReady()) throw new Error('The navigation container has not mounted yet.')
  const root = nav.getRootState() as StateLike | undefined
  const path: string[] = []
  let holder = root
  let leaf = root && focused(root)
  while (leaf) {
    path.push(leaf.name)
    if (!leaf.state?.routes.length) break
    holder = leaf.state
    leaf = focused(holder)
  }
  const routes = holder?.routes.slice(0, (holder.index ?? holder.routes.length - 1) + 1) ?? []
  const out: CurrentRoute = {
    name: leaf?.name ?? '',
    path,
    stack: routes.map((r) => (r.params ? { name: r.name, params: r.params } : { name: r.name })),
    canGoBack: nav.canGoBack(),
  }
  if (leaf?.params) out.params = leaf.params
  return out
}

function allRouteNames(state: StateLike | undefined, into = new Set<string>()): Set<string> {
  if (!state) return into
  for (const n of state.routeNames ?? []) into.add(n)
  for (const r of state.routes) {
    into.add(r.name)
    allRouteNames(r.state, into)
  }
  return into
}

// Turns the focused chain of a parsed path into one nested navigate call.
function nestedNavigate(state: StateLike): [string, object | undefined] {
  const route = focused(state)!
  const next = route.state && route.state.routes.length ? nestedNavigate(route.state) : undefined
  if (!next) return [route.name, route.params]
  return [route.name, { ...route.params, screen: next[0], ...(next[1] ? { params: next[1] } : {}) }]
}

/**
 * Navigate without taps. Pass the container ref from `createNavigationContainerRef()`
 * (or `useNavigationContainerRef()`). The tools are named `nav.*`, so they sit
 * beside `routerTools` from the expo-router adapter without clashing.
 */
export function navTools(nav: NavigationRefLike, options: NavToolsOptions = {}): Tools {
  const parse = options.linking?.getStateFromPath ?? options.getStateFromPath

  const wait = (go: () => void): Promise<void> =>
    new Promise((resolve, reject) => {
      let off: (() => void) | undefined
      const done = () => {
        off?.()
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, nav.addListener ? SETTLE_MS : 0)
      off = nav.addListener?.('state', done)
      try {
        go()
      } catch (error) {
        off?.()
        clearTimeout(timer)
        reject(error)
      }
    })

  const ready = () => {
    if (!nav.isReady()) throw new Error('The navigation container has not mounted yet.')
  }

  // Resolves once the new screen has rendered, with the route the app ended on.
  const goTo = async (go: () => void, want?: { name: string; label: string }) => {
    ready()
    await wait(go)
    await settleScreen()
    const route = read(nav)
    if (want && !route.path.includes(want.name))
      return {
        ...route,
        warning: `asked for ${want.label} but the app is on ${route.path.join(' > ')}; the screen may be in a navigator that is not mounted, or the navigation did not run`,
      }
    return route
  }

  const checkName = (name: unknown): string => {
    ready()
    if (typeof name !== 'string' || !name) throw new Error('give a route name, e.g. nav.navigate Profile')
    const known = allRouteNames(nav.getRootState() as StateLike | undefined)
    if (!known.has(name))
      throw new Error(`no route named "${name}". Known routes: ${[...known].join(', ')}`)
    return name
  }

  const fromPath = (path: string): [string, object | undefined] => {
    if (!parse)
      throw new Error(
        'paths need getStateFromPath: navTools(ref, { linking, getStateFromPath }) with getStateFromPath from @react-navigation/native. Or pass a route name.',
      )
    const state = parse(path, options.linking?.config as never)
    if (!state || !state.routes.length)
      throw new Error(`${path} matched no route. Check it against your linking config.`)
    return nestedNavigate(state)
  }

  const action = (type: 'PUSH' | 'REPLACE', name: string, params?: object) => ({
    type,
    payload: { name, params },
  })

  return {
    'nav.navigate': {
      description:
        'Go to a route by name and params, or by a path like /post/7 when getStateFromPath is set. Reuses the screen if it is already in the stack. Returns the route it ended on (name, params, path, stack, canGoBack), with a `warning` if that is not the screen asked for. Throws on an unknown name.',
      run: (target: string, params?: object) => {
        if (typeof target === 'string' && target.startsWith('/')) {
          const [name, nested] = fromPath(target)
          return goTo(() => (nav.navigate as (...a: unknown[]) => void)(name, nested), { name, label: target })
        }
        const name = checkName(target)
        return goTo(() => (nav.navigate as (...a: unknown[]) => void)(name, params), { name, label: name })
      },
    },
    'nav.push': {
      description: 'Push a route onto the focused stack, even if it is already there. Same reply as nav.navigate.',
      run: (target: string, params?: object) => {
        const name = checkName(target)
        return goTo(() => nav.dispatch(action('PUSH', name, params) as never), { name, label: name })
      },
    },
    'nav.replace': {
      description: 'Replace the current screen in its stack. Same reply as nav.navigate.',
      run: (target: string, params?: object) => {
        const name = checkName(target)
        return goTo(() => nav.dispatch(action('REPLACE', name, params) as never), { name, label: name })
      },
    },
    'nav.popToTop': {
      description: 'Pop the focused stack back to its first screen. Returns the route it ended on.',
      run: () => goTo(() => nav.dispatch({ type: 'POP_TO_TOP' } as never)),
    },
    'nav.back': {
      description:
        'Go back once if it can. Returns the route it ended on, or false if it could not. Ignores modals and sheets the app renders itself: close those with the app\'s own tool.',
      run: () => {
        ready()
        return nav.canGoBack() ? goTo(() => nav.goBack()) : false
      },
    },
    'nav.current': {
      description: 'The current route: name, params, path (root navigator down to the screen), stack and canGoBack.',
      run: (): CurrentRoute => read(nav),
    },
  }
}
