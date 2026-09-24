import type { Tools } from '../runtime/types'
import { patchFetch } from './fetch'
import {
  addMock,
  deriveDevHost,
  type Mock,
  mockOrder,
  networkState,
  publicEntry,
  removeMocks,
} from './state'
import type {
  MockHandler,
  MockMatch,
  MockOptions,
  MockResponse,
  MockRoute,
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
    'net.clear': {
      description: 'Empty the request log. Returns how many entries it held.',
      run: () => state.log.splice(0).length,
    },
    'net.restore': {
      description:
        "Undo the agent's network changes: remove agent mocks, keep the app's. Returns how many were removed.",
      run: () => removeMocks(state, isAgent),
    },
  }
}

export type {
  LogEntry,
  MockHandler,
  MockMatch,
  MockOptions,
  MockRequest,
  MockResponse,
  MockRoute,
} from './types'
