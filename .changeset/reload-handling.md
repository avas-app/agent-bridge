---
'@avasapp/agent-bridge': minor
---

A session now notices when the app reloaded and says which pending restores were lost: `app reloaded; N pending restores lost: store, query` comes back with the next call, failed or not (`agent-bridge call` prints it as a warning, `timed()` has it as `notice`, `AgentBridgeCallError` as `notice`), in `agent-bridge run` output, and again in `session stop`. Every reply carries the id of the JS bundle load and the areas with pending undo state (`pending` on a `*.restore` tool), so a reload is caught on the next reply and Fast Refresh is not mistaken for one. On Expo, calls to a reloaded app fail at once instead of timing out. New `app.reload` tool calls `DevSettings.reload()`; a session never runs it twice and waits for the new bridge.
