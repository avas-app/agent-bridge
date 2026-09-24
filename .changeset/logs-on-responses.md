---
'@avasapp/agent-bridge': minor
---

Errors the app logs, throws or leaves unhandled come back with the next tool reply (`logs` on the result, `Timed.logs` in the client), tagged with the tool they happened during or after. `bridge.logs` reads the last 200 errors and warnings. The CLI prints them under each call and step; `run --strict` fails if any came back.
