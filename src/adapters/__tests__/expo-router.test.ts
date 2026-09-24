import { describe, expect, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { type NavigationLike, type RouterLike, routerTools } from '../expo-router'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

type Route = { name: string; params?: Record<string, unknown>; state?: State }
type State = { index: number; routes: Route[] }

// Root state the way expo-router shapes it: one `__root` route holding the app's navigators.
const app = (...routes: Route[]): State => ({
  index: 0,
  routes: [{ name: '__root', state: { index: routes.length - 1, routes } }],
})

const tabs = (tab: string, params?: Record<string, unknown>) =>
  app({ name: '(tabs)', state: { index: 0, routes: [{ name: tab, params }] } })

// A fake expo-router: navigation is queued and applied a tick later, like
// expo-router's routing queue, which flushes from an effect after a render.
function fakeApp(routes: Record<string, State>, start: string) {
  let state = routes[start]
  const history: State[] = []
  const listeners = new Set<() => void>()
  const queue = (next: () => void) =>
    setTimeout(() => {
      for (const l of listeners) l()
      next()
    }, 5)
  const go = (href: string) =>
    queue(() => {
      const next = routes[href]
      if (!next) throw new Error(`no route ${href}`)
      if (state) history.push(state)
      state = next
    })
  const router: RouterLike = {
    navigate: go,
    push: go,
    replace: go,
    back: () => queue(() => (state = history.pop())),
    canGoBack: () => history.length > 0,
  }
  const navigation: NavigationLike = {
    getRootState: () => state,
    isReady: () => true,
    addListener: (_type, callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  }
  return { router, navigation, listeners }
}

describe('routerTools', () => {
  test('router.current sees the route right after router.navigate returns', async () => {
    const { router, navigation, listeners } = fakeApp(
      { '/': tabs('index'), '/inbox': tabs('inbox') },
      '/',
    )
    const tools = routerTools(router, { navigation })

    expect(run(tools, 'router.current')).toMatchObject({ pathname: '/', canGoBack: false })
    expect(await run(tools, 'router.navigate', '/inbox')).toBe('/inbox')
    expect(run(tools, 'router.current')).toEqual({
      pathname: '/inbox',
      href: '/inbox',
      params: {},
      segments: ['(tabs)', 'inbox'],
      name: 'inbox',
      canGoBack: true,
    })
    expect(await run(tools, 'router.back')).toBe(true)
    expect(run(tools, 'router.current')).toMatchObject({ pathname: '/', canGoBack: false })
    expect(await run(tools, 'router.back')).toBe(false)
    expect(listeners.size).toBe(0)
  })

  test('fills dynamic segments and keeps other params as search params', () => {
    const { router, navigation } = fakeApp(
      {
        '/': app(
          { name: '(tabs)', state: { index: 0, routes: [{ name: 'index' }] } },
          {
            name: 'plants/[id]',
            params: { id: 'orchid%20one', tab: 'care' },
          },
        ),
      },
      '/',
    )
    const tools = routerTools(router, { navigation })
    expect(run(tools, 'router.current')).toMatchObject({
      pathname: '/plants/orchid one',
      href: '/plants/orchid one?tab=care',
      params: { id: 'orchid one', tab: 'care' },
      segments: ['plants', '[id]'],
      name: 'plants/[id]',
    })
  })

  test('reads the rest of the path from params when a navigator has not rendered yet', () => {
    const state = app({ name: '(tabs)', params: { screen: 'inbox', params: { filter: 'unread' } } })
    const { router, navigation } = fakeApp({ '/': state }, '/')
    expect(run(routerTools(router, { navigation }), 'router.current')).toMatchObject({
      pathname: '/inbox',
      segments: ['(tabs)', 'inbox'],
    })
  })

  test('catch-all and not-found routes', async () => {
    const { router, navigation } = fakeApp(
      {
        '/docs': app({ name: 'docs/[...slug]', params: { slug: ['a', 'b'] } }),
        '/nope': { index: 0, routes: [{ name: '+not-found', path: '/nope' } as Route] },
      },
      '/docs',
    )
    const tools = routerTools(router, { navigation })
    expect(run(tools, 'router.current')).toMatchObject({ pathname: '/docs/a/b', href: '/docs/a/b' })
    await run(tools, 'router.navigate', '/nope')
    expect(run(tools, 'router.current')).toMatchObject({ pathname: '/nope', segments: ['+not-found'] })
  })

  test('navigation tools still return right away without a navigation container', () => {
    const { router } = fakeApp({ '/': tabs('index') }, '/')
    const tools = routerTools(router)
    expect(run(tools, 'router.navigate', '/')).toBe('/')
    expect(() => run(tools, 'router.current')).toThrow('useNavigationContainerRef()')
  })

  test('a navigation nobody handles gives up instead of hanging', async () => {
    const { router, navigation } = fakeApp({ '/': tabs('index') }, '/')
    const quiet: NavigationLike = { getRootState: navigation.getRootState }
    const t0 = performance.now()
    await run(routerTools({ ...router, navigate: () => {} }, { navigation: quiet }), 'router.navigate', '/x')
    expect(performance.now() - t0).toBeLessThan(500)
  })

  test("expo-router's router with typed routes fits RouterLike", () => {
    type Href = '/' | '/inbox' | { pathname: '/inbox'; params?: object }
    const typed = {
      navigate: (_href: Href, _options?: { withAnchor?: boolean }) => {},
      push: (_href: Href) => {},
      replace: (_href: Href) => {},
      back: () => {},
      canGoBack: () => false,
      dismiss: (_count?: number) => {},
    }
    expect(Object.keys(routerTools(typed))).toContain('router.current')
  })
})
