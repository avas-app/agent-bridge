/**
 * Which requests a mock answers. A bare string is a URL substring. In the
 * object form every key given must match, and at least one of `url`, `path`,
 * `body` or `graphql` is needed.
 */
export type MockMatch =
  | string
  | {
      /** A substring of the URL, a RegExp, or `{ regex }` from JSON. */
      url?: string | RegExp | { regex: string; flags?: string }
      /** The whole path of the URL on any host, query ignored: "/orders/:id" (one segment) or "/files/*" (the rest). "/orders" does not match "/orders/5/items". */
      path?: string
      /** Any method when left out. */
      method?: string
      /** A JSON request body must contain this: objects match key by key, arrays match in length and position, other values are equal. */
      body?: Record<string, unknown> | unknown[]
      /** The GraphQL operationName, from the JSON body or the `?operationName=` query. */
      graphql?: string
    }

export type MockResponse =
  | {
      /** Defaults to 200. */
      status?: number
      /** Sent as JSON, with a JSON content type. Wins over `body`. */
      json?: unknown
      body?: string
      headers?: Record<string, string>
    }
  /** Fails the way a real network failure does. */
  | { offline: true }

/** What a handler sees of the request. */
export type MockRequest = {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  /** The body parsed as JSON, or undefined. */
  json: () => unknown
}

/** Return undefined to let the request through to the next mock or the network. */
export type MockHandler = (
  request: MockRequest,
) => MockResponse | undefined | Promise<MockResponse | undefined>

export type MockOptions = {
  /** Answer this many requests, then remove the mock. */
  times?: number
  /** Wait before answering. */
  delayMs?: number
  /** Higher is tried first among mocks from the same source (agent mocks still come before the app's). Default 0; ties go to the newest. Negative makes a fallback. */
  priority?: number
  /** Registering again with the same id replaces the mock (handy with Fast Refresh). */
  id?: string
}

export type MockRoute = {
  match: MockMatch
  response: MockResponse | MockHandler
  options?: MockOptions
}

export type LogEntry = {
  id: number
  method: string
  url: string
  /** When the request started, epoch ms (the app's clock). */
  startedAt: number
  status?: number
  ms: number
  pending?: boolean
  requestBody?: string
  responseBody?: string
  /** From net.entry only; names are lower case. Credential values are cut unless `{ full: true }`. */
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  /** From net.entry: a body shown is only a preview because the whole one was too large or is gone. */
  truncated?: boolean
  error?: string
  mocked?: boolean
  /** Failed by strict mode: no mock answered it. */
  blocked?: boolean
}

export type StrictOptions = {
  /** URLs strict mode lets through to the network: substrings or RegExps. */
  allow?: Array<string | RegExp>
  /** Status of the error response. Default 501. */
  status?: number
  /** Fail like a network failure instead of answering with a status. */
  offline?: boolean
}
