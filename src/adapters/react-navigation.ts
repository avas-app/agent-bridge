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
  type?: string
  index?: number
  routeNames?: string[]
  routes: { name: string; params?: Record<string, unknown>; state?: StateLike }[]
}

type GetStateFromPath = (path: string, config?: never) => StateLike | undefined

export type NavToolsOptions = {
  /** Your `linking` object; its `config` is how a path like `/post/7` is matched to a screen. */
  linking?: { config?: unknown; prefixes?: string[]; getStateFromPath?: GetStateFromPath }
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
  let stackHolder = root?.type === 'stack' ? root : undefined
  let leaf = root && focused(root)
  while (leaf) {
    path.push(leaf.name)
    if (!leaf.state?.routes.length) break
    holder = leaf.state
    if (holder.type === 'stack') stackHolder = holder
    leaf = focused(holder)
  }
  // Only a stack's routes are a history; for tabs or a drawer, show the nearest stack above.
  const routes = stackHolder
    ? stackHolder.routes.slice(0, (stackHolder.index ?? stackHolder.routes.length - 1) + 1)
    : leaf
      ? [leaf]
      : []
  const out: CurrentRoute = {
    name: leaf?.name ?? '',
    path,
    stack: routes.map((r) => (r.params ? { name: r.name, params: r.params } : { name: r.name })),
    canGoBack: nav.canGoBack(),
  }
  if (leaf?.params) out.params = leaf.params
  return out
}

// The navigator holding the focused screen, and the nearest stack at or above it.
function focusedNavigators(root: StateLike | undefined) {
  let holder = root
  let stack = root?.type === 'stack' ? root : undefined
  let leaf = root && focused(root)
  while (leaf?.state?.routes.length) {
    holder = leaf.state
    if (holder.type === 'stack') stack = holder
    leaf = focused(holder)
  }
  return { holder, stack }
}

// The chain of screen names a navigate call asks for: the name, then each nested `screen` param.
function wantedChain(name: string, params?: unknown): string[] {
  const chain = [name]
  let p = params as { screen?: unknown; params?: unknown } | undefined
  while (p && typeof p.screen === 'string') {
    chain.push(p.screen)
    p = p.params as typeof p
  }
  return chain
}

const endsWithChain = (path: string[], chain: string[]) =>
  path.some((_, i) => chain.every((n, j) => path[i + j] === n))

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
  const goTo = async (go: () => void, want?: { chain: string[]; label: string; mustChange?: boolean }) => {
    ready()
    const before = nav.getRootState()
    await wait(go)
    await settleScreen()
    const route = read(nav)
    const missed = want && !endsWithChain(route.path, want.chain)
    if (want && (missed || (want.mustChange && nav.getRootState() === before)))
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
      throw new Error(
        `no route named "${name}". Known routes: ${[...known].join(', ')}. If it is inside a navigator that has not been opened yet, navigate to the parent with {screen: name}.`,
      )
    return name
  }

  // '/post/7', or a URL starting with one of linking.prefixes, is a path; anything else is a route name.
  const asPath = (target: string): string | undefined => {
    if (target.startsWith('/')) return target
    const prefix = options.linking?.prefixes?.find((p) => target.startsWith(p))
    return prefix === undefined ? undefined : `/${target.slice(prefix.length).replace(/^\/+/, '')}`
  }

  const fromPath = (path: string): [string, object | undefined] => {
    if (!parse)
      throw new Error(
        'paths need getStateFromPath: navTools(ref, { linking, getStateFromPath }) with getStateFromPath from @react-navigation/native. Or pass a route name.',
      )
    if (options.linking?.config === undefined)
      throw new Error(
        'paths need linking.config (the screens map). With a static config or linking {enabled: "auto"} there is none to pass: use a route name.',
      )
    const state = parse(path, options.linking?.config as never)
    if (!state || !state.routes.length)
      throw new Error(`${path} matched no route. Check it against your linking config.`)
    const [name, nested] = nestedNavigate(state)
    return [checkName(name), nested]
  }

  // push and replace bubble up to a parent stack when the focused navigator is tabs or a drawer.
  const needStack = (verb: string) => {
    ready()
    const { holder } = focusedNavigators(nav.getRootState() as StateLike | undefined)
    if (holder?.type && holder.type !== 'stack')
      throw new Error(
        `the focused navigator is a ${holder.type} navigator, so ${verb} would act on a parent. Use nav.navigate.`,
      )
  }

  const action = (type: 'PUSH' | 'REPLACE', name: string, params?: object) => ({
    type,
    payload: { name, params },
  })

  return {
    'nav.navigate': {
      description:
        'Go to a route by name and params ({screen, params} reaches a nested screen), or by a path like /post/7 (or a URL with one of linking.prefixes) when getStateFromPath and linking.config are set. In a stack it goes back to the screen if that is focused and otherwise pushes (React Navigation 7; v6 reuses a screen already in the stack): use nav.popTo to return to an earlier one. Returns the route it ended on (name, params, path, stack, canGoBack), with a `warning` if the screens asked for are not at the end of the path. Throws on an unknown name.',
      run: (target: string, params?: object) => {
        const path = typeof target === 'string' ? asPath(target) : undefined
        if (path !== undefined) {
          const [name, nested] = fromPath(path)
          return goTo(() => (nav.navigate as (...a: unknown[]) => void)(name, nested), {
            chain: wantedChain(name, nested),
            label: target,
          })
        }
        const name = checkName(target)
        const chain = wantedChain(name, params)
        return goTo(() => (nav.navigate as (...a: unknown[]) => void)(name, params), { chain, label: chain.join(' > ') })
      },
    },
    'nav.push': {
      description:
        'Push a route onto the focused stack, even if it is already there. Throws when the focused navigator is tabs or a drawer (use nav.navigate). Same reply as nav.navigate.',
      run: (target: string, params?: object) => {
        const name = checkName(target)
        needStack('push')
        return goTo(() => nav.dispatch(action('PUSH', name, params) as never), { chain: [name], label: name, mustChange: true })
      },
    },
    'nav.replace': {
      description:
        'Replace the current screen in its stack. Throws when the focused navigator is tabs or a drawer (use nav.navigate). Same reply as nav.navigate.',
      run: (target: string, params?: object) => {
        const name = checkName(target)
        needStack('replace')
        return goTo(() => nav.dispatch(action('REPLACE', name, params) as never), { chain: [name], label: name, mustChange: true })
      },
    },
    'nav.popTo': {
      description:
        'Go back to the nearest earlier screen with this name in the focused stack, or replace the current screen with it if there is none (React Navigation 7 only). Same reply as nav.navigate.',
      run: (target: string, params?: object) => {
        const name = checkName(target)
        return goTo(() => nav.dispatch({ type: 'POP_TO', payload: { name, params } } as never), { chain: [name], label: name })
      },
    },
    'nav.popToTop': {
      description:
        'Pop the nearest stack back to its first screen. If that stack is already at its first screen it does nothing, so a parent stack is never popped. Returns the route it ended on.',
      run: async () => {
        ready()
        const { stack } = focusedNavigators(nav.getRootState() as StateLike | undefined)
        if (stack && (stack.index ?? stack.routes.length - 1) === 0) return read(nav)
        return goTo(() => nav.dispatch({ type: 'POP_TO_TOP' } as never))
      },
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
