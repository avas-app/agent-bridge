# @avasapp/agent-bridge

## 0.1.0

### Minor Changes

- a99f57e: Errors the app logs, throws or leaves unhandled come back with the next tool reply (`logs` on the result, `Timed.logs` in the client), tagged with the tool they happened during or after. `bridge.logs` reads the last 200 errors and warnings. The CLI prints them under each call and step; `run --strict` fails if any came back.
- a4a8d4a: New `@avasapp/agent-bridge/network` subpath: `networkTools()` logs fetch and XMLHttpRequest traffic (`net.log`, `net.clear`) and lets agents mock responses, failures and offline (`net.mock`, `net.unmock`, `net.mocks`, `net.restore`). Apps can register their own mocks, including stateful handlers, with `mock()` and `mockRequests()`; `net.restore` removes only the agent's.
- aade64e: - `bridge.restore` undoes what the agent changed by running every tool named `*.restore`, in name order, and reports each result or error.
  - New `query.restore`, `store.restore` and `mmkv.restore` unpin and refetch queries, put back store state from before `store.set`/`store.call`, and put back MMKV keys from before `mmkv.set`/`mmkv.delete`.
- 05479a5: - `router.current` returns the current route (pathname, href, params, segments, name, canGoBack). Pass `routerTools(router, { navigation: useNavigationContainerRef() })`; the navigation tools then return once the route has changed.
  - `routerTools` accepts expo-router's `router` with typed routes on.
- 1f83e71: - New built-in tools: `screen.snapshot` lists the buttons, inputs, text and testID views on screen; `screen.press` and `screen.fill` call a control's handlers by testID, label, placeholder or text; `screen.waitFor` waits for a target to appear or go.
  - `press` and `fill` return once React has committed what they caused. Custom tools can do the same with the new `settle()` export.
- a244811: - Sessions: `agent-bridge session start` connects to the app once in the background, and `call`, `tools` and `run` go through it with no discovery (about 50 ms per CLI call instead of 650). It reconnects after a reload, and `session stop` or 15 minutes idle runs `bridge.restore` and ends it. `--no-session` connects directly; `connectSession()` does the same from code.

### Patch Changes

- f1d5a06: - `screen.findText` works on React Native 0.8x: it measures through Fabric's UIManager instead of host instances React now creates only for refs. It also measures DOM elements (react-dom, react-native-web) and no longer imports React Native internals, which broke web bundles.
  - `query.set`, `query.pin` and `query.refetch` return after the screen has the data, so a check right after them sees it.
  - Pins survive tools being rebuilt on every render, so `query.unpinAll` still finds them.
