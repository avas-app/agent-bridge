---
'@avasapp/agent-bridge': patch
---

Calls use the running session even when Metro is on a non-default port. `--metro` and `--device` only narrow the choice when given (flag or `AGENT_BRIDGE_METRO`); with one session it is used, with several the call fails and lists them (pass `--session <name>`). `call` names the session in its timing line.
