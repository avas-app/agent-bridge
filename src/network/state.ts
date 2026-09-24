import type {
  LogEntry,
  MockHandler,
  MockMatch,
  MockOptions,
  MockRequest,
  MockResponse,
} from './types'

export const LOG_SIZE = 100

export type MockSource = 'app' | 'agent'

export type Mock = {
  id: string
  source: MockSource
  match: MockMatch
  response: MockResponse | MockHandler
  times?: number
  delayMs: number
  hits: number
  seq: number
  test: (method: string, url: string) => boolean
}

export type NetworkState = {
  installed: boolean
  log: LogEntry[]
  nextLogId: number
  mocks: Mock[]
  nextSeq: number
  /** Above zero while the patched fetch calls the original, which on React Native builds an XHR. */
  insideFetch: number
  /** host:port of Metro, when the app can tell. */
  devHost: string | null
  skip: Array<string | RegExp>
  uninstall: Array<() => void>
}

// On globalThis, so a second copy of this module (or tools rebuilt on every
// render) still sees the one interceptor, log and mock list.
const KEY = Symbol.for('@avasapp/agent-bridge/network')

export function networkState(): NetworkState {
  const g = globalThis as unknown as Record<symbol, NetworkState | undefined>
  g[KEY] ??= {
    installed: false,
    log: [],
    nextLogId: 1,
    mocks: [],
    nextSeq: 1,
    insideFetch: 0,
    devHost: null,
    skip: [],
    uninstall: [],
  }
  return g[KEY]
}

/** Undo every patch and forget all state. For tests. */
export function resetNetworkState(): void {
  const state = networkState()
  for (const undo of state.uninstall.splice(0).reverse()) undo()
  delete (globalThis as unknown as Record<symbol, unknown>)[KEY]
}

// ---- URLs and skip rules ----

const URL_PARTS = /^(?:[a-z][a-z0-9+.-]*:)?(?:\/\/([^/?#]*))?([^?#]*)/i

export const hostOf = (url: string) => URL_PARTS.exec(url)?.[1] ?? ''
const pathOf = (url: string) => URL_PARTS.exec(url)?.[2] ?? ''

// Metro and Expo dev-server endpoints. Matched on the whole path, so an API's
// `/v1/status` still gets logged while Metro's `/status` does not.
const DEV_PATH =
  /^\/(symbolicate|logs|status|hot|message|inspector|expo-dev-plugins|_expo)(\/.*)?$|\.(bundle|map)$/

export function isSkipped(state: NetworkState, url: string): boolean {
  const host = hostOf(url)
  if (state.devHost && host === state.devHost) return true
  if (DEV_PATH.test(pathOf(url))) return true
  return state.skip.some((rule) =>
    typeof rule === 'string' ? url.includes(rule) : rule.test(url),
  )
}

/** Metro's host:port from the bundle URL, on native. Null on web and in tests. */
export function deriveDevHost(): string | null {
  try {
    // Required lazily so this file loads without React Native (tests, web).
    // oxlint-disable-next-line no-require-imports
    const rn = require('react-native') as {
      TurboModuleRegistry?: { get?: (name: string) => unknown }
      NativeModules?: Record<string, unknown>
    }
    type SourceCode = {
      scriptURL?: string
      getConstants?: () => { scriptURL?: string }
    }
    const module = (rn.TurboModuleRegistry?.get?.('SourceCode') ??
      rn.NativeModules?.SourceCode) as SourceCode | undefined
    const scriptURL = module?.getConstants?.().scriptURL ?? module?.scriptURL
    return typeof scriptURL === 'string' && /^https?:/i.test(scriptURL)
      ? hostOf(scriptURL) || null
      : null
  } catch {
    return null
  }
}

// ---- the log ----

export function startEntry(
  state: NetworkState,
  fields: Pick<LogEntry, 'method' | 'url' | 'requestBody'>,
): LogEntry & { started: number } {
  const entry = {
    id: state.nextLogId++,
    ...fields,
    ms: 0,
    pending: true,
    started: Date.now(),
  }
  if (entry.requestBody === undefined) delete entry.requestBody
  state.log.push(entry)
  if (state.log.length > LOG_SIZE)
    state.log.splice(0, state.log.length - LOG_SIZE)
  return entry
}

export function finishEntry(
  entry: LogEntry & { started: number },
  fields: Pick<LogEntry, 'status' | 'error' | 'responseBody'>,
): void {
  entry.ms = Date.now() - entry.started
  delete entry.pending
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined) (entry as Record<string, unknown>)[key] = value
}

/** Copies without bookkeeping, pending ones with their time so far. */
export function publicEntry(entry: LogEntry): LogEntry {
  const { started, ...rest } = entry as LogEntry & { started?: number }
  return rest.pending && started !== undefined
    ? { ...rest, ms: Date.now() - started }
    : rest
}

// ---- mocks ----

function urlTest(url: Exclude<MockMatch, string>['url']): (u: string) => boolean {
  if (typeof url === 'string') return (u) => u.includes(url)
  const regex = url instanceof RegExp ? url : new RegExp(url.regex, url.flags)
  return (u) => {
    regex.lastIndex = 0
    return regex.test(u)
  }
}

function compileMatch(match: MockMatch): Mock['test'] {
  const spec = typeof match === 'string' ? { url: match } : match
  if (!spec || spec.url === undefined)
    throw new Error('A mock needs a match: a URL substring or { url, method? }')
  const testUrl = urlTest(spec.url)
  const method = spec.method?.toUpperCase()
  return (m, u) => (!method || method === m) && testUrl(u)
}

export function addMock(
  state: NetworkState,
  source: MockSource,
  match: MockMatch,
  response: MockResponse | MockHandler,
  options: MockOptions = {},
): Mock {
  if (!response || (typeof response !== 'object' && typeof response !== 'function'))
    throw new Error('A mock needs a response: { status?, json?, body?, headers? }, { offline: true } or a handler')
  const seq = state.nextSeq++
  const id = options.id ?? `${source}-${seq}`
  removeMocks(state, (m) => m.id === id)
  const mock: Mock = {
    id,
    source,
    match,
    response,
    times: options.times,
    delayMs: options.delayMs ?? 0,
    hits: 0,
    seq,
    test: compileMatch(match),
  }
  state.mocks.push(mock)
  return mock
}

export function removeMocks(
  state: NetworkState,
  which: (mock: Mock) => boolean,
): number {
  const before = state.mocks.length
  state.mocks = state.mocks.filter((m) => !which(m))
  return before - state.mocks.length
}

/** The order mocks get a say in: agent before app, newest first. */
export const mockOrder = (a: Mock, b: Mock) =>
  Number(b.source === 'agent') - Number(a.source === 'agent') || b.seq - a.seq

export function matchingMocks(
  state: NetworkState,
  method: string,
  url: string,
): Mock[] {
  return state.mocks.filter((m) => m.test(method, url)).sort(mockOrder)
}

export type Answer = { mock: Mock; response: MockResponse }

/**
 * The first matching mock that answers. Handlers returning undefined pass.
 * Counts the use against `times` and drops a spent mock.
 */
export async function answer(
  state: NetworkState,
  candidates: Mock[],
  request: () => Promise<MockRequest>,
): Promise<Answer | null> {
  for (const mock of candidates) {
    if (!state.mocks.includes(mock)) continue
    const response =
      typeof mock.response === 'function'
        ? await mock.response(await request())
        : mock.response
    if (!response) continue
    mock.hits += 1
    if (mock.times !== undefined && mock.hits >= mock.times)
      removeMocks(state, (m) => m === mock)
    return { mock, response }
  }
  return null
}

export function mockRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
): MockRequest {
  return {
    method,
    url,
    headers,
    body,
    json: () => {
      try {
        return body === undefined ? undefined : JSON.parse(body)
      } catch {
        return undefined
      }
    },
  }
}

/** Status, body text and headers for a static mock response. */
export function responseParts(response: MockResponse): {
  status: number
  text: string
  headers: Record<string, string>
} {
  const r = response as Exclude<MockResponse, { offline: true }>
  const status = r.status ?? 200
  if (r.json !== undefined)
    return {
      status,
      text: JSON.stringify(r.json),
      headers: { 'content-type': 'application/json', ...r.headers },
    }
  return { status, text: r.body ?? '', headers: { ...r.headers } }
}

export const isOffline = (response: MockResponse): response is { offline: true } =>
  (response as { offline?: boolean }).offline === true

export const OFFLINE_MESSAGE = 'Network request failed'

export const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
