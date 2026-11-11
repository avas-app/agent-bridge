# Adapters

| Import | Tools | Needs |
| --- | --- | --- |
| `@avasapp/agent-bridge/tanstack-query` | `query.list` `get` `set` `pin` `unpin` `unpinAll` `refetch` `invalidate` `restore` | your `QueryClient` |
| `@avasapp/agent-bridge/zustand` | `store.list` `get` `set` `call` `restore` | your stores |
| `@avasapp/agent-bridge/react-native-mmkv` | `mmkv.list` `keys` `get` `set` `delete` `restore` | your MMKV instances |
| `@avasapp/agent-bridge/expo-router` | `router.navigate` `push` `replace` `back` `dismiss` `dismissAll` `current` | `router` and `useNavigationContainerRef()` from expo-router |
| `@avasapp/agent-bridge/react-navigation` | `nav.navigate` `push` `replace` `back` `popToTop` `current` | your container ref (`createNavigationContainerRef()`), for apps on `@react-navigation/native` without expo-router |
| `@avasapp/agent-bridge/react-native-webview` | `webview.list` `snapshot` `press` `fill` `waitFor` `url` `reload` `messages` `message` `send` `receive` `restore` | `useWebViewTools` on each WebView, see [WebViews](webviews.md) |
| `@avasapp/agent-bridge/network` | `net.log` `entry` `mock` `mockFromLog` `mocks` `unmock` `strict` `clear` `restore` | nothing: patches `fetch` and `XMLHttpRequest` in dev |
| `@avasapp/agent-bridge/ably` | `realtime.channels` `log` `emit` `mute` `unmute` `connection` `restore` | your Ably `Realtime` client, see [Realtime](realtime.md) |
| `@avasapp/agent-bridge/socket.io` | `realtime.channels` `log` `emit` `mute` `unmute` `connection` `restore` | your socket.io `Socket` |
| `@avasapp/agent-bridge/realtime` | `realtime.channels` `log` `emit` `mute` `unmute` `restore` | two lines in your own subscribe function |

A pin keeps seeded data in place through refetches until you unpin it. `net.mock('/inbox', { status: 500 })` or `{ offline: true }` fails a route (the newest mock is tried first; `{ priority }` reorders mocks from the same source); `net.entry <id>` returns a logged request with whole bodies and `net.mockFromLog <id> [patch]` turns its response into a mock; apps can fake a whole backend with `mockRequests` or `mockApi` from the same import, and turn on strict mode with `strictNetwork` (see [Scenarios](scenarios.md)).

`router.navigate`, `push` and `replace` need the navigation container to wait for the new screen. They then return the route the app ended on, an object like `router.current`'s (not the href string they used to return), throw if it landed on `+not-found`, and add a `warning` when the route is not the href: a different path, or a `?key=value` of the href missing from the route's params (a redirect, or nothing happened). Before the container has mounted they return `{href, warning}`.

**React Navigation.** `navTools(navigationRef)` is for apps that use `@react-navigation/native` directly. Its tools are `nav.*`, not `router.*`, so it never clashes with `routerTools` if both are mounted. `nav.navigate Profile '{"id":3}'` goes to a route by name (and params); `nav.push` and `nav.replace` do what they say; `nav.back` and `nav.popToTop` pop. Each waits for the new screen and returns the route the app ended on: `{ name, params, path, stack, canGoBack }`, where `path` is the names from the root navigator down to the screen and `stack` is the focused navigator's screens. A `warning` says so when the app did not end on the screen asked for. An unknown name throws and lists the known names (those in the navigators mounted now). Pass `getStateFromPath` from `@react-navigation/native` (and your `linking` object) to let `nav.navigate` take a path like `/post/7`:

```ts
// in AgentBridge: tools: { ...navTools(navigationRef, { linking, getStateFromPath }) }
```

**Modals.** `router.back` pops the navigator and knows nothing about modals or sheets your app renders itself, so it can pop the screen under an open one. `router.dismiss` and `router.dismissAll` close route-based modals. For app-rendered modals there is no reliable way to press hardware back from JS (iOS has no back button, and Android's `BackHandler` cannot be fired from outside), so register a tool with your own modal system and let the agent call it:

```ts
// in AgentBridge: tools: { ...routerTools(router, { navigation }), 'modal.close': () => modalStore.getState().closeTop() }
```
