---
'@avasapp/agent-bridge': patch
---

A session now notices when the app reloaded and says which pending restores were lost: `app reloaded; N pending restores lost: store, query` comes back with the next call (`agent-bridge call` prints it as a warning, `timed()` has it as `notice`) and again in `session stop`. `bridge.ping` returns the id of the bridge install so a reload is caught even when the connection survives it. New `app.reload` tool calls `DevSettings.reload()`.
