import type { Tools } from '../runtime/types'
import { type ApiRoutes, apiRoutes, type MockApiOptions } from './api'
import { patchFetch } from './fetch'
import {
  addMock,
  deriveDevHost,
  type Mock,
  mockOrder,
  networkState,
  publicEntry,
  removeMocks,
  strictRule,
  strictRules,
} from './state'
import type {
  MockHandler,
  MockMatch,
  MockOptions,
  MockResponse,
  MockRoute,
  StrictOptions,
} from './types'
import { patchXhr } from './xhr'

/**
 * Starts logging fetch and XMLHttpRequest traffic. Runs once per app; mocks
 * and `networkTools()` call it for you. Metro and Expo dev-server requests are
 * never logged or mocked.
 */
export function installNetwork(): void {
  const state = networkState()
  if (state.installed) return
  state.installed = true
  state.devHost = deriveDevHost()
  for (const undo of [patchXhr(state), patchFetch(state)])
    if (undo) state.uninstall.push(undo)
}

/**
 * Answers matching requests from the app's own code, e.g. a fake backend.
 * Agent mocks (from `net.mock`) take precedence; `net.restore` keeps these.
 */
export function mock(
  match: MockMatch,
  response: MockResponse | MockHandler,
  options?: MockOptions,
): { id: string; remove: () => boolean } {
  installNetwork()
  const state = networkState()
  const { id } = addMock(state, 'app', match, response, options)
  return { id, remove: () => removeMocks(state, (m) => m.id === id) > 0 }
}

/** Registers several app mocks. Returns a function that removes them. */
export function mockRequests(routes: MockRoute[]): () => void {
  const added = routes.map((r) => mock(r.match, r.response, r.options))
  return () => {
    for (const m of added) m.remove()
  }
}

/**
 * Answers many endpoints under one base URL, e.g. a scenario's fixtures:
 * `mockApi(API, { 'GET /me': { json: user }, 'GET /plants/:id': ({ params }) => ... })`.
 * `:name` matches a path segment and `*` the rest; the query string is ignored.
 * Pass '' as the base URL to match the path on any host. Returns a function
 * that removes the routes.
 */
export function mockApi(
  baseUrl: string,
  routes: ApiRoutes,
  options?: MockApiOptions,
): () => void {
  return mockRequests(apiRoutes(baseUrl, routes, options))
}

/**
 * Strict mode: a fetch or XMLHttpRequest that no mock answers fails with an
 * error response (501 by default) and a console error naming it, instead of
 * reaching a server. Only JS requests: native networking (images, native
 * SDKs, WebSockets) isn't covered. Returns a function that turns it off.
 */
export function strictNetwork(options: StrictOptions = {}): () => void {
  installNetwork()
  const state = networkState()
  const rule = strictRule(options)
  state.strictApp.push(rule)
  return () => {
    state.strictApp = state.strictApp.filter((r) => r !== rule)
  }
}

export type NetworkToolsOptions = {
  /** Extra URLs never to log or mock: substrings or RegExps. */
  skip?: Array<string | RegExp>
}

const describeMock = (m: Mock) => ({
  id: m.id,
  source: m.source,
  match: m.match instanceof RegExp ? String(m.match) : m.match,
  response: typeof m.response === 'function' ? '[handler]' : m.response,
  times: m.times,
  hits: m.hits,
  delayMs: m.delayMs || undefined,
})

/** Read the request log and mock responses: `net.*`. */
export function networkTools(options: NetworkToolsOptions = {}): Tools {
  installNetwork()
  const state = networkState()
  if (options.skip) state.skip = options.skip
  const isAgent = (m: Mock) => m.source === 'agent'

  return {
    'net.log': {
      description:
        'Recent requests, newest first: method, url, status, ms, bodies (~2 KB), error, mocked. Filter by url substring or method; clear: true empties the log after reading.',
      run: (
        filter: {
          url?: string
          method?: string
          limit?: number
          clear?: boolean
        } = {},
      ) => {
        const method = filter.method?.toUpperCase()
        const entries = state.log
          .filter(
            (e) =>
              (!filter.url || e.url.includes(filter.url)) &&
              (!method || e.method === method),
          )
          .reverse()
          .slice(0, filter.limit ?? 20)
          .map(publicEntry)
        if (filter.clear) state.log.length = 0
        return entries
      },
    },
    'net.mock': {
      description:
        'Answer matching requests with a canned response until unmocked. match: "/path" or { url: string | { regex }, method? }. response: { status?, json?, body?, headers? } or { offline: true }. options: { times?, delayMs? }.',
      run: (
        match: MockMatch,
        response: MockResponse,
        mockOptions: Omit<MockOptions, 'id'> = {},
      ) => {
        if (typeof response !== 'object' || response === null)
          throw new Error('response must be an object, e.g. { status: 500 }')
        const { times, delayMs } = mockOptions
        return { id: addMock(state, 'agent', match, response, { times, delayMs }).id }
      },
    },
    'net.mocks': {
      description: 'Active mocks, agent and app, in the order they are tried.',
      run: () =>
        [...state.mocks].sort(mockOrder).map(describeMock),
    },
    'net.unmock': {
      description:
        'Remove one agent mock by id, or every agent mock when no id. Returns how many.',
      run: (id?: string) =>
        removeMocks(state, (m) => isAgent(m) && (id === undefined || m.id === id)),
    },
    'net.strict': {
      description:
        'Strict mode: requests no mock answers fail with a 501 instead of reaching a server. [true | false | { allow?: [substring | { regex }], status? }] sets it for the agent, [null] follows the app again; no args reads it. Returns { strict, source, allow, blocked }.',
      run: (...args: unknown[]) => {
        if (args.length) {
          const value = args[0]
          if (value === null || value === undefined) state.strictAgent = null
          else if (value === false) state.strictAgent = false
          else if (value === true) state.strictAgent = strictRule()
          else if (typeof value === 'object') state.strictAgent = strictRule(value as StrictOptions)
          else throw new Error('Pass true, false, null or { allow?, status? }')
        }
        const rules = strictRules(state)
        return {
          strict: rules.length > 0,
          source: state.strictAgent !== null ? 'agent' : rules.length ? 'app' : null,
          allow: rules.flatMap((r) => r.allowShown),
          blocked: [...state.blocked.values()].slice(-20).reverse(),
        }
      },
    },
    'net.clear': {
      description:
        'Empty the request log and the strict-mode blocked list. Returns how many log entries it held.',
      run: () => {
        state.blocked.clear()
        return state.log.splice(0).length
      },
    },
    'net.restore': {
      description:
        "Undo the agent's network changes: remove agent mocks and its net.strict setting, keep the app's. Returns how many mocks were removed.",
      run: () => {
        state.strictAgent = null
        return removeMocks(state, isAgent)
      },
    },
  }
}

export type { ApiHandler, ApiRequest, ApiRoutes, MockApiOptions } from './api'
export type {
  LogEntry,
  MockHandler,
  MockMatch,
  MockOptions,
  MockRequest,
  MockResponse,
  MockRoute,
  StrictOptions,
} from './types'
