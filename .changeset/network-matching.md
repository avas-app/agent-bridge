---
"@avasapp/agent-bridge": minor
---

Network mocks can match more exactly. `net.mock` takes `{path: "/orders/:id"}` (the whole path on any host, query ignored; `:name` is one segment, `*` the rest), `{body: {...}}` (the JSON request body contains these keys) and `{graphql: "GetUser"}` (the request's `operationName`, from the JSON body or `?operationName=`), alone or with `url` and `method`. A bare string still matches any URL containing it, and `net.mock` and `net.mocks` now return `matches`, the mock in words. An unknown key in a match is now an error instead of being ignored. `net.mockFromLog` on a GraphQL request now only answers that operation, where it used to answer every request to the endpoint. Strict mode lists blocked GraphQL requests by operation and names mocks that matched the URL but not the body.

New `net.waitFor(match, {timeoutMs, status, sinceId})` waits for a matching request to finish and returns its entry. `net.entry` now shows request and response headers, with Authorization, Cookie, Set-Cookie, Proxy-Authorization and X-Api-Key values cut to a short prefix unless you pass `{full: true}`. `networkTools({logSize})` sets how many requests the log keeps. An XHR aborted just after `send()` is no longer sent when no mock answers it.
