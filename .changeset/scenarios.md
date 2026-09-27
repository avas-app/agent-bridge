---
'@avasapp/agent-bridge': minor
---

Scenarios: named setups the app defines, such as a locally signed-in user, passed as `useAgentBridge({ scenarios })`. An agent lists them with `agent-bridge scenarios` and applies one with `scenario.apply`. A flow declares what it needs (`export const scenario = 'signedIn'`), and `agent-bridge run` applies it first and runs `bridge.restore` afterwards, even when the flow fails. `run --scenario <name>` adds one to any flow. A scenario's `onUndo` callbacks run after every other restorer. `createGate` holds off app side effects, such as a realtime connection, while a scenario runs. The network entry adds strict mode (`strictNetwork()`, `net.strict`), where a fetch or XHR that no mock answers fails with a 501 (or like offline) and an error naming the request, and `mockApi(baseUrl, routes)` for fixtures with `:param` routes.
