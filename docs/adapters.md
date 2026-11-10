# Adapters

| Import | Tools | Needs |
| --- | --- | --- |
| `@avasapp/agent-bridge/tanstack-query` | `query.list` `get` `set` `pin` `unpin` `unpinAll` `refetch` `invalidate` `restore` | your `QueryClient` |
| `@avasapp/agent-bridge/zustand` | `store.list` `get` `set` `call` `restore` | your stores |
| `@avasapp/agent-bridge/react-native-mmkv` | `mmkv.list` `keys` `get` `set` `delete` `restore` | your MMKV instances |
| `@avasapp/agent-bridge/expo-router` | `router.navigate` `push` `replace` `back` `dismiss` `dismissAll` `current` | `router` and `useNavigationContainerRef()` from expo-router |
| `@avasapp/agent-bridge/react-native-webview` | `webview.list` `snapshot` `press` `fill` `waitFor` `url` `reload` `messages` `message` `send` `receive` `restore` | `useWebViewTools` on each WebView, see [WebViews](webviews.md) |
| `@avasapp/agent-bridge/network` | `net.log` `entry` `waitFor` `mock` `mockFromLog` `mocks` `unmock` `strict` `clear` `restore` | nothing: patches `fetch` and `XMLHttpRequest` in dev |
| `@avasapp/agent-bridge/ably` | `realtime.channels` `log` `emit` `mute` `unmute` `connection` `restore` | your Ably `Realtime` client, see [Realtime](realtime.md) |
| `@avasapp/agent-bridge/socket.io` | `realtime.channels` `log` `emit` `mute` `unmute` `connection` `restore` | your socket.io `Socket` |
| `@avasapp/agent-bridge/realtime` | `realtime.channels` `log` `emit` `mute` `unmute` `restore` | two lines in your own subscribe function |

A pin keeps seeded data in place through refetches until you unpin it. `net.mock('/inbox', { status: 500 })` or `{ offline: true }` fails a route (the newest mock is tried first; `{ priority }` reorders mocks from the same source); `net.entry <id>` returns a logged request with whole bodies and its headers (Authorization, Cookie, Set-Cookie, Proxy-Authorization and X-Api-Key values are cut to a short prefix unless you pass `{"full": true}`) and `net.mockFromLog <id> [patch]` turns its response into a mock; apps can fake a whole backend with `mockRequests` or `mockApi` from the same import, and turn on strict mode with `strictNetwork` (see [Scenarios](scenarios.md)).

**Matching requests.** A string match is a URL substring, so `"/orders"` also answers `/orders/5/items`. For anything exact use the object form, where every key given must match: `{ path: "/orders/:id" }` matches the whole path on any host and ignores the query (`:name` is one segment, `*` the rest, a trailing slash is allowed, no `?` or `#`); `{ body: { status: "open" } }` matches a JSON request body that contains those keys (objects by key, arrays by length and position, other values by `===`; form and binary bodies never match); `{ graphql: "GetUser" }` matches a request whose `operationName` is that, in a single JSON body or the `?operationName=` query (a batched array body does not match; match it with `body`). `url` and `method` work as before. `net.mock` and `net.mocks` return `matches`, the mock in words. A body check needs the request body: for `fetch(new Request(...))` it is read from a clone. In strict mode, a request that only matched mocks by URL is blocked, the error names those mocks, and `net.strict` lists blocked GraphQL requests by operation.

`net.waitFor(match, { timeoutMs?, status?, sinceId? })` waits for a request that matches the same way to finish and returns its entry. Requests already in the log count, so pass `sinceId` (an id from `net.log`) to ignore older ones. Body and graphql matches need the logged request body (JSON up to 1 MB; a Request object's body is logged only when a mock read it). `networkTools({ logSize })` sets how many requests the log keeps (default 100).

**Modals.** `router.back` pops the navigator and knows nothing about modals or sheets your app renders itself, so it can pop the screen under an open one. `router.dismiss` and `router.dismissAll` close route-based modals. For app-rendered modals there is no reliable way to press hardware back from JS (iOS has no back button, and Android's `BackHandler` cannot be fired from outside), so register a tool with your own modal system and let the agent call it:

```ts
// in AgentBridge: tools: { ...routerTools(router, { navigation }), 'modal.close': () => modalStore.getState().closeTop() }
```
