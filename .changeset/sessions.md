---
'@avasapp/agent-bridge': minor
---

- Sessions: `agent-bridge session start` connects to the app once in the background, and `call`, `tools` and `run` go through it with no discovery (about 50 ms per CLI call instead of 650). It reconnects after a reload, and `session stop` or 15 minutes idle runs `bridge.restore` and ends it. `--no-session` connects directly; `connectSession()` does the same from code.
