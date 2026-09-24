/** Which requests a mock answers. A bare string is a URL substring. */
export type MockMatch =
  | string
  | {
      /** A substring of the URL, a RegExp, or `{ regex }` from JSON. */
      url: string | RegExp | { regex: string; flags?: string }
      /** Any method when left out. */
      method?: string
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
  status?: number
  ms: number
  pending?: boolean
  requestBody?: string
  responseBody?: string
  error?: string
  mocked?: boolean
}
