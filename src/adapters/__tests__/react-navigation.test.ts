import { describe, expect, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { type NavigationRefLike, navTools } from '../react-navigation'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

type Route = { key: string; name: string; params?: Record<string, unknown>; state?: State }
type State = { type: 'stack' | 'tab'; index: number; routeNames: string[]; routes: Route[] }

const r = (name: string, params?: Record<string, unknown>, state?: State): Route => ({
  key: name,
  name,
  params,
  state,
})
const stack = (names: string[], routes: Route[], index = routes.length - 1): State => ({
  type: 'stack',
  index,
  routeNames: names,
  routes,
})
const tabs = (names: string[], routes: Route[], index = 0): State => ({
  type: 'tab',
  index,
  routeNames: names,
  routes,
})

type Action = { type: string; payload?: { name: string; params?: Record<string, unknown> } }

// React Navigation 7 routers: stack handles NAVIGATE (push unless the name is focused), PUSH, REPLACE,
// POP_TO_TOP (only above index 0), POP_TO; tabs handle only NAVIGATE. Unhandled actions bubble to the parent.
function route(state: State, a: Action): State | null {
  const name = a.payload?.name
  const params = a.payload?.params
  const known = name !== undefined && state.routeNames.includes(name)
  const focusedRoute = state.routes[state.index]!
  if (state.type === 'tab') {
    if (a.type !== 'NAVIGATE' || !known) return null
    const at = state.routes.findIndex((x) => x.name === name)
    return { ...state, index: at, routes: state.routes.map((x, i) => (i === at ? withParams(x, params) : x)) }
  }
  switch (a.type) {
    case 'NAVIGATE':
      if (!known) return null
      if (focusedRoute.name === name)
        return { ...state, routes: state.routes.map((x, i) => (i === state.index ? withParams(x, params) : x)) }
    // falls through: a name that is not focused is pushed
    case 'PUSH':
      if (!known) return null
      return { ...state, index: state.routes.length, routes: [...state.routes, withParams(r(name!), params)] }
    case 'REPLACE':
      if (!known) return null
      return { ...state, routes: [...state.routes.slice(0, -1), withParams(r(name!), params)] }
    case 'POP_TO_TOP':
      return state.index > 0 ? { ...state, index: 0, routes: state.routes.slice(0, 1) } : null
    case 'POP_TO': {
      if (!known) return null
      const at = state.routes.map((x) => x.name).lastIndexOf(name!, state.index)
      if (at < 0) return { ...state, routes: [...state.routes.slice(0, state.index), withParams(r(name!), params)] }
      return { ...state, index: at, routes: state.routes.slice(0, at + 1).map((x, i) => (i === at ? withParams(x, params) : x)) }
    }
    case 'GO_BACK':
      return state.index > 0 ? { ...state, index: state.index - 1, routes: state.routes.slice(0, -1) } : null
  }
  return null
}

function withParams(x: Route, params?: Record<string, unknown>): Route {
  if (!params) return x
  const { screen, params: inner, ...rest } = params as { screen?: string; params?: Record<string, unknown> }
  let next: Route = { ...x, params: Object.keys(rest).length || !screen ? rest : x.params }
  // Nested { screen } params go to the child navigator, which ignores a name it does not have.
  if (screen && x.state) {
    const child = dispatchIn(x.state, { type: 'NAVIGATE', payload: { name: screen, params: inner } })
    if (child) next = { ...next, state: child }
  }
  return next
}

// Gives the action to the deepest focused navigator first, then each parent in turn.
function dispatchIn(state: State, a: Action): State | null {
  const child = state.routes[state.index]?.state
  if (child) {
    const inner = dispatchIn(child, a)
    if (inner) return { ...state, routes: state.routes.map((x, i) => (i === state.index ? { ...x, state: inner } : x)) }
  }
  return route(state, a)
}

// A fake container: actions apply synchronously, the 'state' event fires a tick later, like React Navigation.
function fakeContainer(initial: State, options: { ready?: boolean } = {}) {
  let state = initial
  const listeners = new Set<() => void>()
  const dispatched: unknown[] = []
  const send = (a: Action) => {
    const next = dispatchIn(state, a)
    if (!next) return
    state = next
    setTimeout(() => {
      for (const l of listeners) l()
    }, 5)
  }
  const ref: NavigationRefLike = {
    getRootState: () => state,
    isReady: () => options.ready ?? true,
    canGoBack: () => {
      const deep = (st: State): boolean =>
        st.type === 'stack' && st.routes.length > 1 ? true : st.routes[st.index]?.state ? deep(st.routes[st.index]!.state!) : false
      return deep(state)
    },
    navigate: ((name: string, params?: Record<string, unknown>) =>
      send({ type: 'NAVIGATE', payload: { name, params } })) as never,
    goBack: () => send({ type: 'GO_BACK' }),
    dispatch: (action: unknown) => {
      dispatched.push(action)
      send(action as Action)
    },
    addListener: (_type: 'state', cb: () => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  return { ref, dispatched }
}

const names = ['Home', 'Profile', 'Settings']
const fails = (p: () => unknown) => expect(Promise.resolve().then(p))

describe('navTools', () => {
  test('nav.current reports the focused route, the nested path and the stack', () => {
    const inner = stack(['Feed', 'Post'], [r('Feed'), r('Post', { id: '7' })])
    const { ref } = fakeContainer(stack(['Main'], [r('Main', undefined, inner)]))
    expect(run(navTools(ref), 'nav.current')).toEqual({
      name: 'Post',
      params: { id: '7' },
      path: ['Main', 'Post'],
      stack: [{ name: 'Feed' }, { name: 'Post', params: { id: '7' } }],
      canGoBack: true,
    })
  })

  test('nav.navigate returns the route it ended on', async () => {
    const { ref } = fakeContainer(stack(names, [r('Home')]))
    const tools = navTools(ref)
    expect(await run(tools, 'nav.navigate', 'Profile', { id: 3 })).toMatchObject({
      name: 'Profile',
      params: { id: 3 },
      canGoBack: true,
    })
    expect(run(tools, 'nav.current')).toMatchObject({ name: 'Profile' })
  })

  test('push, replace, popToTop and back', async () => {
    const { ref, dispatched } = fakeContainer(stack(names, [r('Home')]))
    const tools = navTools(ref)
    expect(await run(tools, 'nav.push', 'Profile')).toMatchObject({ name: 'Profile' })
    expect(await run(tools, 'nav.push', 'Settings')).toMatchObject({ name: 'Settings' })
    expect(await run(tools, 'nav.replace', 'Profile', { a: 1 })).toMatchObject({ name: 'Profile', params: { a: 1 } })
    expect(await run(tools, 'nav.back')).toMatchObject({ name: 'Profile' })
    expect(await run(tools, 'nav.popToTop')).toMatchObject({ name: 'Home', canGoBack: false })
    expect(dispatched.length).toBe(4)
    expect(await run(tools, 'nav.back')).toBe(false)
  })

  test('unknown route names throw and list the known ones', async () => {
    const { ref } = fakeContainer(stack(names, [r('Home')]))
    const tools = navTools(ref)
    await expect(Promise.resolve().then(() => run(tools, 'nav.navigate', 'Nope'))).rejects.toThrow(
      /no route named "Nope".*Home, Profile, Settings/,
    )
  })

  test('warns when the app did not end on the route', async () => {
    const { ref } = fakeContainer(stack(names, [r('Home')]))
    ref.navigate = (() => {}) as never
    const out = (await run(navTools(ref), 'nav.navigate', 'Profile')) as { warning?: string }
    expect(out.warning).toMatch(/asked for Profile but the app is on Home/)
  })

  test('a container that has not mounted', async () => {
    const { ref } = fakeContainer(stack(names, [r('Home')]), { ready: false })
    const tools = navTools(ref)
    expect(() => run(tools, 'nav.current')).toThrow(/not mounted/)
    await expect(Promise.resolve().then(() => run(tools, 'nav.navigate', 'Home'))).rejects.toThrow(/not mounted/)
  })

  test('a path goes through getStateFromPath into a nested navigate', async () => {
    const inner = stack(['Feed', 'Post'], [r('Feed')])
    const { ref } = fakeContainer(stack(['Main'], [r('Main', undefined, inner)]))
    const calls: unknown[][] = []
    ref.navigate = ((...args: unknown[]) => calls.push(args)) as never
    const tools = navTools(ref, {
      linking: { config: { screens: {} } },
      getStateFromPath: (path: string) => {
        if (path !== '/post/7') return undefined
        return { routes: [{ name: 'Main', state: { routes: [{ name: 'Post', params: { id: '7' } }] } }] }
      },
    })
    await run(tools, 'nav.navigate', '/post/7')
    expect(calls).toEqual([['Main', { screen: 'Post', params: { id: '7' } }]])
    await expect(Promise.resolve().then(() => run(tools, 'nav.navigate', '/zzz'))).rejects.toThrow(/matched no route/)
  })

  test('a path without getStateFromPath explains what to pass', async () => {
    const { ref } = fakeContainer(stack(names, [r('Home')]))
    await expect(Promise.resolve().then(() => run(navTools(ref), 'nav.navigate', '/x'))).rejects.toThrow(
      /getStateFromPath/,
    )
  })
})

describe('navTools review fixes', () => {
  const settingsInner = () => stack(['SettingsHome', 'Profil'], [r('SettingsHome')])
  const nested = () =>
    fakeContainer(stack(['Home', 'Settings'], [r('Home'), r('Settings', undefined, settingsInner())]))

  test('navigate warns when only the top-level name of a nested target was reached', async () => {
    const { ref } = nested()
    const out = (await run(navTools(ref), 'nav.navigate', 'Settings', { screen: 'Missing' })) as { warning?: string }
    expect(out.warning).toMatch(/asked for Settings > Missing but the app is on Settings > SettingsHome/)
  })

  test('navigate with a nested screen that exists does not warn', async () => {
    const { ref } = nested()
    const out = (await run(navTools(ref), 'nav.navigate', 'Settings', { screen: 'Profil' })) as { warning?: string; path: string[] }
    expect(out.warning).toBeUndefined()
    expect(out.path).toEqual(['Settings', 'Profil'])
  })

  test('a path warns when its inner screen is not reached', async () => {
    const { ref } = nested()
    const tools = navTools(ref, {
      linking: { config: { screens: {} } },
      getStateFromPath: () => ({ routes: [{ name: 'Settings', state: { routes: [{ name: 'Nope' }] } }] }),
    })
    const out = (await run(tools, 'nav.navigate', '/settings/nope')) as { warning?: string }
    expect(out.warning).toMatch(/asked for \/settings\/nope/)
  })

  test('navigate pushes in v7 when the name is in the stack but not focused; popTo goes back to it', async () => {
    const { ref } = fakeContainer(stack(names, [r('Home'), r('Profile')]))
    const tools = navTools(ref)
    expect(await run(tools, 'nav.navigate', 'Home')).toMatchObject({ stack: [{ name: 'Home' }, { name: 'Profile' }, { name: 'Home' }] })
    expect(await run(tools, 'nav.popTo', 'Profile')).toMatchObject({ stack: [{ name: 'Home' }, { name: 'Profile' }] })
  })

  test('push or replace the focused tab warns or throws instead of looking like success', async () => {
    const feed = () => fakeContainer(tabs(['Feed', 'Inbox'], [r('Feed'), r('Inbox')]))
    const { ref } = feed()
    await fails(() => run(navTools(ref), 'nav.push', 'Feed')).rejects.toThrow(/tab navigator/)
    await fails(() => run(navTools(ref), 'nav.replace', 'Inbox')).rejects.toThrow(/tab navigator/)
  })

  test('push warns when the state did not change', async () => {
    const { ref } = fakeContainer(stack(names, [r('Home')]))
    ref.dispatch = (() => {}) as never
    const out = (await run(navTools(ref), 'nav.push', 'Home')) as { warning?: string }
    expect(out.warning).toMatch(/did not run|did not change/)
  })

  test('popToTop at the first screen does not pop a parent navigator', async () => {
    const cart = stack(['Cart'], [r('Cart')])
    const { ref, dispatched } = fakeContainer(
      stack(['Tabs', 'Checkout'], [r('Tabs'), r('Checkout', undefined, cart)]),
    )
    const out = (await run(navTools(ref), 'nav.popToTop')) as { name: string; path: string[] }
    expect(out.path).toEqual(['Checkout', 'Cart'])
    expect(dispatched).toEqual([])
  })

  test('nav.current stack is the nearest stack when the focused navigator is tabs', () => {
    const t = tabs(['Feed', 'Inbox'], [r('Feed'), r('Inbox')], 1)
    const { ref } = fakeContainer(stack(['Home', 'Main'], [r('Home'), r('Main', undefined, t)]))
    const cur = run(navTools(ref), 'nav.current') as { path: string[]; stack: { name: string }[] }
    expect(cur.path).toEqual(['Main', 'Inbox'])
    expect(cur.stack.map((x) => x.name)).toEqual(['Home', 'Main'])
  })

  test('unknown-name error points at navigating to the parent', async () => {
    const { ref } = fakeContainer(stack(names, [r('Home')]))
    await fails(() => run(navTools(ref), 'nav.navigate', 'Nope')).rejects.toThrow(/not been opened yet.*screen: name/)
  })

  test('a path whose first screen is unknown throws', async () => {
    const { ref } = fakeContainer(stack(names, [r('Home')]))
    const tools = navTools(ref, { linking: { config: {} }, getStateFromPath: () => ({ routes: [{ name: 'Ghost' }] }) })
    await fails(() => run(tools, 'nav.navigate', '/ghost')).rejects.toThrow(/no route named "Ghost"/)
  })

  test('paths without linking.config throw', async () => {
    const { ref } = fakeContainer(stack(names, [r('Home')]))
    const tools = navTools(ref, { getStateFromPath: () => ({ routes: [{ name: 'Home' }] }) })
    await fails(() => run(tools, 'nav.navigate', '/home')).rejects.toThrow(/linking\.config/)
  })

  test('a URL with a linking prefix is parsed as a path', async () => {
    const { ref } = fakeContainer(stack(names, [r('Home')]))
    const seen: string[] = []
    const tools = navTools(ref, {
      linking: { config: {}, prefixes: ['myapp://'] },
      getStateFromPath: (p: string) => (seen.push(p), { routes: [{ name: 'Profile' }] }),
    })
    expect(await run(tools, 'nav.navigate', 'myapp://profile/7')).toMatchObject({ name: 'Profile' })
    expect(seen).toEqual(['/profile/7'])
  })
})
