---
"@avasapp/agent-bridge": patch
---

When nothing listens on the Metro address, the CLI and `connect()` now look for Metro on ports 8081-8090, 8100-8199 and running sessions' addresses (within a second, only after the failure) and name what they found with its apps, plus the `--metro` flag or `AGENT_BRIDGE_METRO` value to use. "No app is connected" and "No app matches" add the likely causes, and `devices` fails with the same hint instead of printing "No apps connected." when Metro isn't there.
