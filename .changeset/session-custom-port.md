---
'@avasapp/agent-bridge': patch
---

Calls use the running session even when Metro is on a non-default port. With no `--metro`/`--device`/`--session`, `call`, `tools` and `run` use the one session started from the same project (nearest `package.json`), so a session from another project is never picked up by accident. `--metro`, `--device`, `--session` and `AGENT_BRIDGE_*` still reach any session. With several matching sessions the call fails and lists them (pass `--session <name>`). Every command that goes through a session prints `Using session "<name>"` on stderr.
