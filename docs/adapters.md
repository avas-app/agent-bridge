# Adapters

| Import | Tools | Needs |
| --- | --- | --- |
| `@avasapp/agent-bridge/tanstack-query` | `query.list` `get` `set` `pin` `unpin` `unpinAll` `refetch` `invalidate` `restore` | your `QueryClient` |
| `@avasapp/agent-bridge/zustand` | `store.list` `get` `set` `call` `restore` | your stores |
| `@avasapp/agent-bridge/react-native-mmkv` | `mmkv.list` `keys` `get` `set` `delete` `restore` | your MMKV instances |
| `@avasapp/agent-bridge/async-storage` | `asyncStorage.list` `get` `set` `delete` `restore` | your AsyncStorage |
| `@avasapp/agent-bridge/secure-store` | `secureStore.list` `get` `set` `delete` `restore` | `expo-secure-store` and the keys your app uses |
| `@avasapp/agent-bridge/expo-router` | `router.navigate` `push` `replace` `back` `dismiss` `dismissAll` `current` | `router` and `useNavigationContainerRef()` from expo-router |
| `@avasapp/agent-bridge/react-native-webview` | `webview.list` `snapshot` `press` `fill` `waitFor` `url` `reload` `messages` `message` `send` `receive` `restore` | `useWebViewTools` on each WebView, see [WebViews](webviews.md) |
| `@avasapp/agent-bridge/network` | `net.log` `entry` `mock` `mockFromLog` `mocks` `unmock` `strict` `clear` `restore` | nothing: patches `fetch` and `XMLHttpRequest` in dev |
| `@avasapp/agent-bridge/ably` | `realtime.channels` `log` `emit` `mute` `unmute` `connection` `restore` | your Ably `Realtime` client, see [Realtime](realtime.md) |
| `@avasapp/agent-bridge/socket.io` | `realtime.channels` `log` `emit` `mute` `unmute` `connection` `restore` | your socket.io `Socket` |
| `@avasapp/agent-bridge/realtime` | `realtime.channels` `log` `emit` `mute` `unmute` `restore` | two lines in your own subscribe function |

`asyncStorage.list` returns `{total, keys}` with each value cut to 200 characters (`{limit}` defaults to 50, `{prefix}` filters keys); `asyncStorage.get` returns the whole string. Both storages are async, and `*.restore` waits for each write. A restore puts back each key the agent changed to what it held before the agent's first write to it, and deletes keys that did not exist; keys it can't put back stay pending and the call throws.

SecureStore holds secrets, so `secureStore.get` returns `[redacted, N chars]` unless you pass `{full:true}`, and `bridge.pending` only says that something is pending. `secureStore.set` and `delete` can still change them, so wire it only in dev builds you trust. SecureStore cannot list its keys: `secureStoreTools(SecureStore, ['authToken'])` takes the keys your app uses for `secureStore.list` (set or not, and length, never the value); any other key is reachable by name with `secureStore.get`.

A pin keeps seeded data in place through refetches until you unpin it. `net.mock('/inbox', { status: 500 })` or `{ offline: true }` fails a route (the newest mock is tried first; `{ priority }` reorders mocks from the same source); `net.entry <id>` returns a logged request with whole bodies and `net.mockFromLog <id> [patch]` turns its response into a mock; apps can fake a whole backend with `mockRequests` or `mockApi` from the same import, and turn on strict mode with `strictNetwork` (see [Scenarios](scenarios.md)).

`router.navigate`, `push` and `replace` need the navigation container to wait for the new screen. They then return the route the app ended on, an object like `router.current`'s (not the href string they used to return), throw if it landed on `+not-found`, and add a `warning` when the route is not the href: a different path, or a `?key=value` of the href missing from the route's params (a redirect, or nothing happened). Before the container has mounted they return `{href, warning}`.

**Modals.** `router.back` pops the navigator and knows nothing about modals or sheets your app renders itself, so it can pop the screen under an open one. `router.dismiss` and `router.dismissAll` close route-based modals. For app-rendered modals there is no reliable way to press hardware back from JS (iOS has no back button, and Android's `BackHandler` cannot be fired from outside), so register a tool with your own modal system and let the agent call it:

```ts
// in AgentBridge: tools: { ...routerTools(router, { navigation }), 'modal.close': () => modalStore.getState().closeTop() }
```
