# Writing a scenario

<!-- Mirrors docs/scenarios.md in the agent-bridge repo. Keep the two in sync. -->

A scenario is a named setup the app defines once, for example a user who is
signed in **locally**: a fake token, a fake user, and every request answered in
the app, never by the real server. Agents then apply it with one call instead of
signing in.

```ts
import { type Scenarios, useAgentBridge } from '@avasapp/agent-bridge'
import { mockApi, strictNetwork } from '@avasapp/agent-bridge/network'

const scenarios: Scenarios = {
  signedIn: {
    description: 'Signed in locally; no request reaches a server.',
    // JSON Schema: bad options fail before apply runs, and say why.
    options: {
      type: 'object',
      properties: {
        user: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' } } },
      },
    },
    apply: async ({ options, call, onUndo }) => {
      const user = { ...defaultUser, ...options?.user }
      // Guards first, so nothing leaves the app with the fake token.
      onUndo(realtimeGate.close())
      onUndo(strictNetwork({ allow: ['cdn.example.com'] }))
      onUndo(mockApi(API_URL, {
        'GET /me': { json: user },
        'GET /orders/:id': ({ params }) => ({ json: orders[params.id] }),
      }))
      onUndo(await addNativeRewriteRule(tilesHost, localTiles))  // any app code
      await call('store.set', 'auth', { token: 'local', user })  // store.restore undoes it
      return { user }
    },
  },
}

useAgentBridge({ tools, scenarios })
```

- `options` is a JSON Schema (2020-12, checked with `@cfworker/json-schema`,
  which needs no `eval` and runs on Hermes). `scenario.apply` checks the options
  before anything changes, and lists every problem at once, such as
  `options/user/email: String does not match format "email"`. An object schema
  that lists `properties` rejects other keys
  (`options: unknown option "usr". Known: user`) unless it sets
  `additionalProperties`. So a typo fails instead of being ignored. No options
  are checked as `{}`, so `required` ones are reported.
- `apply` is ordinary app code. `call(tool, ...args)` runs a bridge tool, and
  that tool's own restorer undoes the change. `onUndo(fn)` covers everything
  else: app mocks, gates, native state such as a URL-rewrite rule.
- `bridge.restore` runs every scenario's undo callbacks **last**, newest first,
  after the store, query and network restorers. The guards stay up until the app
  is back in its real state. If `apply` throws, the callbacks it had registered
  run straight away.
- Tools: `scenario.list`, `scenario.apply [name, options?]` (applying an active
  one again undoes it first) and `scenario.restore`. `npx agent-bridge scenarios`
  lists them.
- Flows declare scenarios with `export const scenario` or
  `export const scenarios`; see [flows.md](flows.md).

## Strict network

`strictNetwork({ allow?, status?, offline? })` from `@avasapp/agent-bridge/network`
(or `net.strict` from the agent) fails every `fetch` or `XMLHttpRequest` that no
mock answers. The request gets a 501 with
`{ error: "agent-bridge strict network: no mock for GET https://…" }` and a
`console.error`, so the agent sees it with the reply. With `offline: true` it
fails like a network failure instead. `net.strict` lists the requests it
blocked. `allow` lets hosts through (substrings or RegExps); Metro always gets
through. It covers JS requests only: images, native SDKs (a map's tile fetches,
say), and WebSockets go around it, so a scenario handles those with app code and
`onUndo`.

## Fixtures

`mockApi(baseUrl, routes, options?)` answers `'METHOD /path'` routes, or
`'/path'` for any method. `:name` matches one path segment and `*` the rest; the
query string is ignored. A route's value is a response (`{ json }`,
`{ status, body }`…) or a handler that gets the request with `params` and
`query`. It returns a function that removes the routes.

## Gates

Some side effects must wait while a scenario runs, such as a realtime client
connecting with the fake token and signing the user out when auth fails.
`createGate(name)` from `@avasapp/agent-bridge` is a counted switch:
`gate.close()` returns the function that reopens it (hand that to `onUndo`),
`gate.closed` is what app code checks, and `gate.subscribe(fn)` hears it change.
In a release build it's always open. `realtime.connection` isn't enough on its
own: it hides the state from the app, but the client still connects.

The agent-bridge repo's example app has a complete local `signedIn` in
`example/src/dev/scenarios.ts`, and `example/flows/checks/signed-in.mjs`
declares it.
