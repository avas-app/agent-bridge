---
'@avasapp/agent-bridge': patch
---

`agent-bridge mcp` now lists the built-in tools (`screen_*`, `app_*`, `bridge_*`, `scenario_*`) before an app connects, with their real descriptions, so clients that ignore `tools/list_changed` and registries that run the server with no app can see them. Calling one with no app connected returns an error that says why. Once an app connects, the list is the app's own tools (built-ins it doesn't have drop out), and `tools/list_changed` is sent only if that list differs from the one already shown.
