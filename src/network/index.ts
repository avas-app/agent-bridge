import type { Tools } from '../runtime/types'
import { signalMocksRemoved } from '../shared/mock-signal'
import { type ApiRoutes, apiRoutes, type MockApiOptions } from './api'
import { patchFetch } from './fetch'
import {
  addMock,
  deriveDevHost,
  fullResponse,
  type Mock,
  mockOrder,
  networkState,
  publicEntry,
  removeMocks,
  shadowedMocks,
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
 * Agent mocks (from `net.mock`) are tried first, whatever their priority;
 * `net.restore` keeps these.
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
 * error response (501 by default, or like offline with `offline: true`) and
 * a console error naming it, instead of
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

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Objects merge key by key; anything else in the patch replaces. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlain(base) || !isPlain(patch)) return patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(base[key], value)
  return out
}

const describeMock = (m: Mock) => ({
  id: m.id,
  source: m.source,
  match: m.match instanceof RegExp ? String(m.match) : m.match,
  response: typeof m.response === 'function' ? '[handler]' : m.response,
  times: m.times,
  hits: m.hits,
  delayMs: m.delayMs || undefined,
  priority: m.priority || undefined,
})

/** Read the request log and mock responses: `net.*`. */
export function networkTools(options: NetworkToolsOptions = {}): Tools {
  installNetwork()
  const state = networkState()
  if (options.skip) state.skip = options.skip
  const isAgent = (m: Mock) => m.source === 'agent'
  const logged = (id: number) => {
    const entry = state.log.find((e) => e.id === id)
    if (!entry) throw new Error(`No logged request with id ${id}; it may have left the log`)
    return entry
  }
  const addAgentMock = (
    match: MockMatch,
    response: MockResponse,
    { times, delayMs, priority }: Omit<MockOptions, 'id'>,
  ) => {
    const added = addMock(state, 'agent', match, response, { times, delayMs, priority })
    const shadows = shadowedMocks(state, added).map((m) => m.id)
    return shadows.length ? { id: added.id, shadows } : { id: added.id }
  }

  return {
    'net.log': {
      description:
        'Recent requests, newest first: method, url, startedAt (epoch ms), status, ms, bodies (~2 KB, cut with "… (+N chars)"), error, mocked. Filter by url substring, method, since (epoch ms: startedAt >= since) or sinceId (id > sinceId); full: true returns whole bodies (truncated: true when one is too large or gone); clear: true empties the log after reading. net.entry gets one request whole.',
      run: (
        filter: {
          url?: string
          method?: string
          since?: number
          sinceId?: number
          limit?: number
          full?: boolean
          clear?: boolean
        } = {},
      ) => {
        const method = filter.method?.toUpperCase()
        if (filter.since !== undefined && !(filter.since >= 1e11))
          throw new Error('since is an epoch time in ms (e.g. Date.now()); use sinceId for log ids')
        const entries = state.log
          .filter(
            (e) =>
              (!filter.url || e.url.includes(filter.url)) &&
              (!method || e.method === method) &&
              (filter.since === undefined || e.startedAt >= filter.since) &&
              (filter.sinceId === undefined || e.id > filter.sinceId),
          )
          .reverse()
          .slice(0, filter.limit ?? 20)
          .map((e) => publicEntry(e, filter.full))
        if (filter.clear) state.log.length = 0
        return entries
      },
    },
    'net.entry': {
      description:
        'One logged request by id, with its request and response bodies whole (not cut at ~2 KB). Ids come from net.log.',
      run: (id: number) => publicEntry(logged(id), true),
    },
    'net.mock': {
      description:
        'Answer matching requests with a canned response until unmocked. match: "/path" or { url: string | { regex }, method? }. response: { status?, json?, body?, headers? } or { offline: true }. options: { times?, delayMs?, priority? }. The newest mock is tried first, so a later broad mock shadows an earlier specific one; give the specific one a higher priority (default 0, ties newest first; negative makes a fallback); agent mocks still come before the app mocks. The result lists `shadows` when the new mock will be tried before an agent mock it also matches.',
      run: (
        match: MockMatch,
        response: MockResponse,
        mockOptions: Omit<MockOptions, 'id'> = {},
      ) => {
        if (typeof response !== 'object' || response === null)
          throw new Error('response must be an object, e.g. { status: 500 }')
        return addAgentMock(match, response, mockOptions)
      },
    },
    'net.mockFromLog': {
      description:
        'Mock the same method and URL as a logged request (id from net.log) with its status and whole response body, optionally changed by patch: JSON objects merge deeply, other values replace. [id, patch?, options?] options as net.mock. Returns { id, match, response }.',
      run: (
        id: number,
        patch?: unknown,
        mockOptions: Omit<MockOptions, 'id'> = {},
      ) => {
        const entry = logged(id)
        if (entry.status === undefined)
          throw new Error(`Request ${id} has no response to copy (${entry.error ?? 'still pending'})`)
        const { state: kept, body, contentType } = fullResponse(entry)
        if (kept !== 'kept' || body === undefined)
          throw new Error(
            `Request ${id}'s response body can't be copied: ${
              {
                pending: 'it is still being read, try again',
                none: 'it was not captured (binary or unreadable)',
                cut: 'it is too large',
                evicted: 'it was dropped to save memory',
                kept: 'it is missing',
              }[kept]
            }`,
          )
        const response: MockResponse = { status: entry.status }
        if (patch !== undefined) {
          let json: unknown
          try {
            json = JSON.parse(body)
          } catch {
            throw new Error(`Request ${id}'s response is not JSON, so it can't take a patch`)
          }
          response.json = deepMerge(json, patch)
        } else {
          // The text as the server sent it, not re-serialised (big ints survive).
          response.body = body
          if (contentType) response.headers = { 'content-type': contentType }
        }
        const match = { url: { regex: `^${escapeRegex(entry.url)}$` }, method: entry.method }
        return { ...addAgentMock(match, response, mockOptions), match: { url: entry.url, method: entry.method }, response }
      },
    },
    'net.mocks': {
      description: 'Active mocks, agent and app, in the order they are tried.',
      run: () =>
        [...state.mocks].sort(mockOrder).map(describeMock),
    },
    'net.unmock': {
      description:
        'Remove one agent mock by id, or every agent mock when no id. Returns how many. With the query adapter, queries that fetched while the mock answered are reset, so its fake data can\'t outlive it.',
      run: (id?: string) => {
        const removed = state.mocks.filter(
          (m) => isAgent(m) && (id === undefined || m.id === id),
        )
        const count = removeMocks(state, (m) => removed.includes(m))
        // A spent mock (times) is already gone, so the id alone still counts.
        signalMocksRemoved(id === undefined ? undefined : [id])
        return count
      },
    },
    'net.strict': {
      description:
        'Strict mode: requests no mock answers fail with a 501 (or like offline) instead of reaching a server. [true | false | { allow?: [substring | { regex }], status?, offline? }] sets it for the agent, [null] follows the app again; no args reads it. Returns { strict, source, allow, blocked }.',
      run: (...args: unknown[]) => {
        if (args.length) {
          const value = args[0]
          if (value === null || value === undefined) state.strictAgent = null
          else if (value === false) state.strictAgent = false
          else if (value === true) state.strictAgent = strictRule()
          else if (typeof value === 'object') state.strictAgent = strictRule(value as StrictOptions)
          else throw new Error('Pass true, false, null or { allow?, status?, offline? }')
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
      pending: () => state.strictAgent !== null || state.mocks.some(isAgent),
      description:
        "Undo the agent's network changes: remove agent mocks and its net.strict setting, keep the app's. Returns how many mocks were removed. With the query adapter, queries that fetched while an agent mock answered are reset (query.restore reports how many).",
      run: () => {
        state.strictAgent = null
        const count = removeMocks(state, isAgent)
        signalMocksRemoved()
        return count
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
