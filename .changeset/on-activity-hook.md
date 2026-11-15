---
'@avasapp/agent-bridge': minor
---

New opt-in activity hook: set `AGENT_BRIDGE_ON_ACTIVITY="<shell command>"` (or pass `--on-activity "<command>"` to `session start`, `call`, `run`, `repl` or `mcp`) and agent-bridge runs that command after a tool call, at most once a minute per process (and per session). It runs in the project directory, detached, with its output discarded, and is stopped after 30 seconds. It never runs for the session's health check or `bridge.ping`. A failing or slow command doesn't change or delay the call; its first failure is reported once (on stderr, or in the session log). Use it to keep something alive while an agent works, such as a leased simulator. Through a session, the variable is read where the session starts and the session runs the command for every client's calls; `--on-activity` on a client adds a command run by that client. Nothing changes without the variable or flag, and an app can't set it.
