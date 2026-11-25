---
'@avasapp/agent-bridge': minor
---

Dials: `dials serve` starts a bridge session when the project has none (`--metro`, `--device`, `--idle`; `--no-session` skips it) and stops it on exit. `dials serve --exec '<cmd>'` runs a command on each Commit (the request as JSON on stdin), so no `dials wait` is needed; `dials show` prints the current request. The panel says when no session is running or no agent is listening.
