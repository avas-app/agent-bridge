import { compileRoute, queryOf } from './api'
import { truncateBody } from './body'
import type { MockMatch } from './types'

/** What a body check sees of a request. */
export type Probe = { url: string; body?: string; json: () => unknown }

export type Compiled = {
  /** Method and URL only: runs without the body. */
  test: (method: string, url: string) => boolean
  /** True when body or graphql also has to match; `testBody` decides it. */
  needsBody: boolean
  /** Never throws. */
  testBody: (probe: Probe) => boolean
  /** In words, for net.mock and net.mocks. */
  matches: string
  /** The same for two matches that are the same. */
  key: string
  /** The URL substring, when there is one. */
  substring?: string
  /** True when the match is only a URL substring and a method. */
  plain: boolean
  method?: string
}

const KEYS = ['url', 'path', 'method', 'body', 'graphql']
const NEED = 'A mock needs a match: a URL substring or { url?, path?, method?, body?, graphql? } with one of url, path, body or graphql'

const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key)

/** Objects match key by key (extra keys are fine), arrays by length and position, the rest by ===. */
export function subset(spec: unknown, actual: unknown): boolean {
  if (spec === null || typeof spec !== 'object') return spec === actual
  if (Array.isArray(spec))
    return (
      Array.isArray(actual) &&
      actual.length === spec.length &&
      spec.every((item, i) => subset(item, actual[i]))
    )
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
  return Object.entries(spec).every(
    ([key, value]) => own(actual, key) && subset(value, (actual as Record<string, unknown>)[key]),
  )
}

/** A GraphQL operationName from a single JSON body, else from the query string. */
export function operationName(probe: Probe): string | undefined {
  const json = probe.json()
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const name = (json as { operationName?: unknown }).operationName
    if (typeof name === 'string') return name
  }
  return queryOf(probe.url).operationName
}

function urlTest(url: unknown): { test: (u: string) => boolean; shown: string; substring?: string } {
  if (typeof url === 'string')
    return { test: (u) => u.includes(url), shown: `URL containing ${JSON.stringify(url)}`, substring: url }
  const isRegex = url instanceof RegExp
  if (!isRegex && !(url && typeof url === 'object' && typeof (url as { regex?: unknown }).regex === 'string'))
    throw new Error('url must be a string, or { regex, flags? }')
  const regex = isRegex ? url : new RegExp((url as { regex: string }).regex, (url as { flags?: string }).flags)
  return {
    test: (u) => {
      regex.lastIndex = 0
      return regex.test(u)
    },
    shown: `URL matching ${String(regex)}`,
  }
}

export function compileMatch(match: MockMatch): Compiled {
  const spec = (typeof match === 'string' ? { url: match } : match) as Record<string, unknown> | null
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || spec instanceof RegExp) throw new Error(NEED)
  const unknown = Object.keys(spec).filter((k) => !KEYS.includes(k))
  if (unknown.length)
    throw new Error(`Unknown match key ${unknown.map((k) => `"${k}"`).join(', ')}; the keys are ${KEYS.join(', ')}`)
  if (['url', 'path', 'body', 'graphql'].every((k) => spec[k] === undefined)) throw new Error(NEED)

  const parts: string[] = []
  const tests: Array<(m: string, u: string) => boolean> = []
  let method: string | undefined
  if (spec.method !== undefined) {
    if (typeof spec.method !== 'string') throw new Error('method must be a string such as "POST"')
    method = spec.method.toUpperCase()
  }
  parts.push(method ?? 'any method')

  let substring: string | undefined
  if (spec.url !== undefined) {
    const u = urlTest(spec.url)
    substring = u.substring
    tests.push((_m, url) => u.test(url))
    parts.push(u.shown)
  }

  if (spec.path !== undefined) {
    const path = spec.path
    if (typeof path !== 'string' || !path.startsWith('/'))
      throw new Error('path is just the path, starting with "/", e.g. "/orders/:id"; use url to pin a host')
    if (/[?#]/.test(path)) throw new Error('path has no query or hash; the query is ignored, use url to match it')
    if (/\s/.test(path)) throw new Error('path has no spaces; write a space as %20')
    const route = compileRoute('', path, { loose: true })
    const decoded = (u: string) => {
      try {
        return decodeURI(u)
      } catch {
        return u
      }
    }
    // The URL as sent or percent-decoded, so "/café" also matches "/caf%C3%A9".
    tests.push((_m, url) => route.regex.test(url) || route.regex.test(decoded(url)))
    parts.push(`path ${path} (whole path, any host)`)
  }

  const probeTests: Array<(p: Probe) => boolean> = []
  if (spec.body !== undefined) {
    const body = spec.body
    // Checked on the JSON copy: { a: undefined } is empty once serialised and would match everything.
    const frozen = (body && typeof body === 'object' ? JSON.parse(JSON.stringify(body)) : undefined) as unknown
    if (!frozen || typeof frozen !== 'object' || (!Array.isArray(frozen) && !Object.keys(frozen).length))
      throw new Error('body must be a non-empty JSON object or an array to look for in the request body')
    probeTests.push((p) => {
      const json = p.json()
      return json !== undefined && subset(frozen, json)
    })
    parts.push(`JSON body containing ${truncateBody(JSON.stringify(frozen))}`)
  }
  if (spec.graphql !== undefined) {
    const name = spec.graphql
    if (typeof name !== 'string' || !name) throw new Error('graphql must be an operation name such as "GetUser"')
    probeTests.push((p) => operationName(p) === name)
    parts.push(`GraphQL operation ${JSON.stringify(name)}`)
  }

  return {
    test: (m, u) => (!method || method === m) && tests.every((t) => t(m, u)),
    needsBody: probeTests.length > 0,
    testBody: (p) => {
      try {
        return probeTests.every((t) => t(p))
      } catch {
        return false
      }
    },
    matches: parts.join(', '),
    key: JSON.stringify([
      method,
      spec.url instanceof RegExp ? String(spec.url) : spec.url,
      spec.path,
      spec.body,
      spec.graphql,
    ]),
    substring,
    plain: substring !== undefined && spec.path === undefined && spec.body === undefined && spec.graphql === undefined,
    method,
  }
}
