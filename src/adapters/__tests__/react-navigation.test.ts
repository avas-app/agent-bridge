import { describe, expect, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { type NavigationRefLike, navTools } from '../react-navigation'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

type Route = { key: string; name: string; params?: Record<string, unknown>; state?: State }
type State = { index: number; routeNames: string[]; routes: Route[] }

const r = (name: string, params?: Record<string, unknown>, state?: State): Route => ({
  key: name,
  name,
  params,
  state,
})
const stack = (names: string[], routes: Route[], index = routes.length - 1): State => ({
  index,
  routeNames: names,
  routes,
})

// A fake container: actions apply synchronously, the 'state' event fires a tick later, like React Navigation.
function fakeContainer(initial: State, options: { ready?: boolean } = {}) {
  let state = initial
  const listeners = new Set<() => void>()
  const dispatched: unknown[] = []
  const change = (next: State) => {
    state = next
    setTimeout(() => {
      for (const l of listeners) l()
    }, 5)
  }
  const root = () => state
  const ref: NavigationRefLike = {
    getRootState: root,
    isReady: () => options.ready ?? true,
    canGoBack: () => {
      const deep = (st: State): boolean => st.routes.length > 1 || (st.routes[st.index]?.state ? deep(st.routes[st.index]!.state!) : false)
      return deep(state)
    },
    navigate: ((name: string, params?: Record<string, unknown>) => {
      const known = state.routeNames.includes(name)
      if (!known) return
      const at = state.routes.findIndex((x) => x.name === name)
      if (at >= 0)
        change({ ...state, index: at, routes: state.routes.map((x, i) => (i === at ? { ...x, params } : x)) })
      else change({ ...state, index: state.routes.length, routes: [...state.routes, r(name, params)] })
    }) as never,
    goBack: () => change({ ...state, index: state.index - 1, routes: state.routes.slice(0, -1) }),
    dispatch: (action: unknown) => {
      dispatched.push(action)
      const a = action as { type: string; payload?: { name: string; params?: Record<string, unknown> } }
      if (a.type === 'PUSH')
        change({ ...state, index: state.routes.length, routes: [...state.routes, r(a.payload!.name, a.payload!.params)] })
      if (a.type === 'REPLACE')
        change({ ...state, routes: [...state.routes.slice(0, -1), r(a.payload!.name, a.payload!.params)] })
      if (a.type === 'POP_TO_TOP') change({ ...state, index: 0, routes: state.routes.slice(0, 1) })
    },
    addListener: (_type: 'state', cb: () => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  return { ref, dispatched }
}

const names = ['Home', 'Profile', 'Settings']

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
