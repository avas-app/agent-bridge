import type {
  MockMatch,
  MockOptions,
  MockRequest,
  MockResponse,
  MockRoute,
} from './types'

/** What a `mockApi` handler sees: the request, plus its path params and query. */
export type ApiRequest = MockRequest & {
  /** `:name` segments of the route, and `*` as "*". */
  params: Record<string, string>
  query: Record<string, string>
}

export type ApiHandler = (
  request: ApiRequest,
) => MockResponse | undefined | Promise<MockResponse | undefined>

/** "METHOD /path" (or "/path" for any method) → a response or a handler. */
export type ApiRoutes = Record<string, MockResponse | ApiHandler>

export type MockApiOptions = Omit<MockOptions, 'id'> & {
  /**
   * Registering again with the same id replaces these routes (handy with
   * Fast Refresh). Each route's mock id is `<id> <METHOD /path>`.
   */
  id?: string
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const ROUTE = /^(?:([A-Za-z]+)\s+)?(\/\S*)$/

/**
 * Compiles "GET /plants/:id" against `baseUrl`. `:name` matches one path
 * segment, `*` the rest of the path; any query string or hash is allowed.
 * `loose` is for `net.mock`'s `path`: `:name` only as a whole segment (so
 * "/items:batchGet" is literal), and a trailing slash is optional either way.
 */
export function compileRoute(
  baseUrl: string,
  route: string,
  { loose = false }: { loose?: boolean } = {},
): { method?: string; regex: RegExp; names: string[] } {
  const parsed = ROUTE.exec(route.trim())
  if (!parsed)
    throw new Error(`Bad route "${route}": use "METHOD /path" or "/path"`)
  const [, method, rawPath] = parsed as unknown as [string, string | undefined, string]
  const path = loose && rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath
  const names: string[] = []
  const pattern = (path === '/' && loose ? '' : path)
    .split(loose ? /(\/:[A-Za-z_][A-Za-z0-9_]*(?=\/|$)|\*)/ : /(:[A-Za-z_][A-Za-z0-9_]*|\*)/)
    .map((part) => {
      if (part === '*') {
        names.push('*')
        return '([^?#]*)'
      }
      if (loose && part.startsWith('/:')) {
        names.push(part.slice(2))
        return '/([^/?#]+)'
      }
      if (!loose && part.startsWith(':')) {
        names.push(part.slice(1))
        return '([^/?#]+)'
      }
      return escape(part)
    })
    .join('')
  // Without a base URL, any origin (or none) before the path.
  const base = baseUrl
    ? escape(baseUrl.replace(/\/+$/, ''))
    : '(?:[a-z][a-z0-9+.-]*://[^/?#]*)?'
  return {
    method: method?.toUpperCase(),
    regex: new RegExp(`^${base}${pattern}${loose ? '/?' : ''}(?:[?#].*)?$`, 'i'),
    names,
  }
}

export function queryOf(url: string): Record<string, string> {
  const search = /\?([^#]*)/.exec(url)?.[1]
  const out: Record<string, string> = {}
  if (!search) return out
  for (const pair of search.split('&')) {
    if (!pair) continue
    const [key, value = ''] = pair.split('=')
    const decode = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '))
      } catch {
        return s
      }
    }
    out[decode(key!)] = decode(value)
  }
  return out
}

/** Turns `mockApi`'s routes into `mockRequests` routes. */
export function apiRoutes(
  baseUrl: string,
  routes: ApiRoutes,
  options: MockApiOptions = {},
): MockRoute[] {
  const { id, ...mockOptions } = options
  return Object.entries(routes).map(([route, response]) => {
    const { method, regex, names } = compileRoute(baseUrl, route)
    const match: MockMatch = { url: regex, method }
    const handler =
      typeof response === 'function'
        ? (request: MockRequest) => {
            const values = regex.exec(request.url)?.slice(1) ?? []
            const params = Object.fromEntries(
              names.map((name, i) => [name, decodeURIComponent(values[i] ?? '')]),
            )
            return response({ ...request, params, query: queryOf(request.url) })
          }
        : response
    return {
      match,
      response: handler,
      options: { ...mockOptions, ...(id && { id: `${id} ${route}` }) },
    }
  })
}
