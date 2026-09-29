import { signalMockAnswered } from '../shared/mock-signal'
import { compactBody, FULL_BUDGET, MAX_FULL_BODY, truncateBody } from './body'
import type {
  LogEntry,
  MockHandler,
  MockMatch,
  MockOptions,
  MockRequest,
  MockResponse,
  StrictOptions,
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
  priority: number
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
  /** Strict mode from `strictNetwork()`; on while any is held. */
  strictApp: StrictRule[]
  /** From `net.strict`: a rule, false for off, null to follow the app. */
  strictAgent: StrictRule | false | null
  /** Requests strict mode failed, by "METHOD url". */
  blocked: Map<string, { method: string; url: string; count: number }>
}

export type StrictRule = {
  allow: Array<(url: string) => boolean>
  /** The allow list as given, for net.strict. */
  allowShown: string[]
  status: number
  offline: boolean
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
    strictApp: [],
    strictAgent: null,
    blocked: new Map(),
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

/** Where a response body stands: only 'kept' can stand in for the real one. */
export type ResponseState = 'pending' | 'kept' | 'none' | 'cut' | 'evicted'

type FullBodies = {
  requestBody?: string
  responseBody?: string
  response?: ResponseState
  contentType?: string
}

/** Untruncated bodies, kept off the entries so `net.log` stays small. */
const FULL = new WeakMap<LogEntry, FullBodies>()

const fullOf = (entry: LogEntry): FullBodies => {
  let full = FULL.get(entry)
  if (!full) FULL.set(entry, (full = {}))
  return full
}

/** Drops the oldest whole bodies until what is kept fits FULL_BUDGET; previews stay. */
function enforceBudget(): void {
  const { log } = networkState()
  const size = (f: FullBodies | undefined) =>
    (f?.requestBody?.length ?? 0) + (f?.responseBody?.length ?? 0)
  let total = log.reduce((sum, e) => sum + size(FULL.get(e)), 0)
  for (const entry of log) {
    if (total <= FULL_BUDGET) return
    const full = FULL.get(entry)
    if (!full || !size(full)) continue
    total -= size(full)
    delete full.requestBody
    if (full.responseBody !== undefined) {
      delete full.responseBody
      full.response = 'evicted'
    }
  }
}

function keepRequestBody(entry: LogEntry, text: string | undefined): void {
  const body = compactBody(text)
  if (body === undefined) return
  entry.requestBody = truncateBody(body)
  if (text!.length <= MAX_FULL_BODY) {
    fullOf(entry).requestBody = text
    enforceBudget()
  }
}

/** Sets the response body from its raw text: a preview for the log, the text itself for `net.entry`. */
export function setResponseBody(
  entry: LogEntry,
  text: string | undefined,
  contentType?: string,
): void {
  const full = fullOf(entry)
  if (contentType !== undefined) full.contentType = contentType
  if (text === undefined) {
    full.response = 'none'
    return
  }
  const body = compactBody(text)
  if (body !== undefined) entry.responseBody = truncateBody(body)
  if (text.length > MAX_FULL_BODY) {
    full.response = 'cut'
    return
  }
  full.responseBody = text
  full.response = 'kept'
  enforceBudget()
}

/** Notes that a response has a body that is still being read, or that can't be logged. */
export function markResponse(entry: LogEntry, response: 'pending' | 'none'): void {
  fullOf(entry).response = response
}

export function startEntry(
  state: NetworkState,
  fields: { method: string; url: string; requestBody?: string },
): LogEntry {
  const entry: LogEntry = {
    id: state.nextLogId++,
    method: fields.method,
    url: fields.url,
    startedAt: Date.now(),
    ms: 0,
    pending: true,
  }
  keepRequestBody(entry, fields.requestBody)
  state.log.push(entry)
  if (state.log.length > LOG_SIZE)
    state.log.splice(0, state.log.length - LOG_SIZE)
  return entry
}

export function finishEntry(
  entry: LogEntry,
  fields: Pick<LogEntry, 'status' | 'error' | 'responseBody'> & { contentType?: string },
): void {
  entry.ms = Date.now() - entry.startedAt
  delete entry.pending
  const { responseBody, contentType, ...rest } = fields
  for (const [key, value] of Object.entries(rest))
    if (value !== undefined) (entry as Record<string, unknown>)[key] = value
  if (responseBody !== undefined) setResponseBody(entry, responseBody, contentType)
}

/** A copy, pending ones with their time so far; `full` puts the untruncated bodies back. */
export function publicEntry(entry: LogEntry, full = false): LogEntry {
  const out = entry.pending ? { ...entry, ms: Date.now() - entry.startedAt } : { ...entry }
  if (full) {
    const { requestBody, responseBody } = FULL.get(entry) ?? {}
    if (requestBody !== undefined) out.requestBody = requestBody
    if (responseBody !== undefined) out.responseBody = responseBody
    // A preview that isn't the whole body says so instead of passing for it.
    const cut = entry.responseBody !== undefined && responseBody === undefined
    const cutRequest = entry.requestBody !== undefined && requestBody === undefined
    if (cut || cutRequest) out.truncated = true
  }
  return out
}

/** A logged response's whole body, when it was kept, with why not otherwise. */
export function fullResponse(entry: LogEntry): {
  state: ResponseState
  body?: string
  contentType?: string
} {
  const full = FULL.get(entry)
  return { state: full?.response ?? 'none', body: full?.responseBody, contentType: full?.contentType }
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
  if (options.priority !== undefined && !Number.isFinite(options.priority))
    throw new Error('priority must be a finite number')
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
    priority: options.priority ?? 0,
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

/** The order mocks get a say in: agent before app, then higher priority, then newest first. */
export const mockOrder = (a: Mock, b: Mock) =>
  Number(b.source === 'agent') - Number(a.source === 'agent') ||
  b.priority - a.priority ||
  b.seq - a.seq

const substringMatch = (match: MockMatch) => {
  const spec = typeof match === 'string' ? { url: match } : match
  return typeof spec.url === 'string'
    ? { url: spec.url, method: spec.method?.toUpperCase() }
    : null
}

/**
 * Agent mocks the new one is tried before and certainly answers instead: both
 * match on a plain URL substring, the new one has a static response and covers
 * the old one's method. Anything less certain isn't reported.
 */
export function shadowedMocks(state: NetworkState, added: Mock): Mock[] {
  const next = substringMatch(added.match)
  if (!next || typeof added.response === 'function') return []
  return state.mocks.filter((old) => {
    if (old === added || old.source !== 'agent' || mockOrder(added, old) >= 0)
      return false
    const prev = substringMatch(old.match)
    return (
      !!prev &&
      prev.url.includes(next.url) &&
      (!next.method || next.method === prev.method)
    )
  })
}

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
    if (mock.source === 'agent') signalMockAnswered(mock.id)
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

/** The content-type in a headers record, whatever its case. */
export const contentTypeOf = (headers: Record<string, string>): string | undefined =>
  Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1]

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

// ---- strict mode ----

type AllowRule = string | RegExp | { regex: string; flags?: string }

export function strictRule(
  options: StrictOptions | { allow?: AllowRule[]; status?: number; offline?: boolean } = {},
): StrictRule {
  const allow = (options.allow ?? []) as AllowRule[]
  if (!Array.isArray(allow))
    throw new Error('allow must be a list of URL substrings or regexes')
  return {
    allow: allow.map((rule) => urlTest(rule)),
    allowShown: allow.map((rule) =>
      typeof rule === 'string' ? rule : String(rule instanceof RegExp ? rule : new RegExp(rule.regex, rule.flags)),
    ),
    status: options.status ?? 501,
    offline: options.offline === true,
  }
}

/** The strict rules in force: the agent's if it set one, else the app's. */
export function strictRules(state: NetworkState): StrictRule[] {
  if (state.strictAgent === false) return []
  return state.strictAgent ? [state.strictAgent, ...state.strictApp] : state.strictApp
}

export const BLOCKED_HEADER = 'x-agent-bridge'

/**
 * In strict mode, the error response for a request no mock answered, unless
 * an allow rule lets it through. Records it and logs it as an error, so the
 * agent sees which request to mock.
 */
export function blockedResponse(
  state: NetworkState,
  method: string,
  url: string,
): MockResponse | null {
  const rules = strictRules(state)
  if (!rules.length || rules.some((r) => r.allow.some((test) => test(url))))
    return null
  const key = `${method} ${url}`
  const seen = state.blocked.get(key)
  if (seen) seen.count += 1
  else state.blocked.set(key, { method, url, count: 1 })
  const error = `agent-bridge strict network: no mock for ${key}`
  console.error(`${error}. Mock it, or allow it in strict mode.`)
  if (rules[0]!.offline) return { offline: true }
  return {
    status: rules[0]!.status,
    json: { error },
    headers: { [BLOCKED_HEADER]: 'blocked' },
  }
}

export const isOffline = (response: MockResponse): response is { offline: true } =>
  (response as { offline?: boolean }).offline === true

export const OFFLINE_MESSAGE = 'Network request failed'

export const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
