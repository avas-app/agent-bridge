---
"@avasapp/agent-bridge": patch
---

A reset or failed connect on a session socket no longer crashes the process with an uncaught error. `agent-bridge mcp` and the session daemon now report it as a normal "session isn't answering" or "closed the connection" error instead.
