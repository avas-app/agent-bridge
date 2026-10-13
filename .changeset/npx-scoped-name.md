---
"@avasapp/agent-bridge": patch
---

The docs, skill and example now say `npx @avasapp/agent-bridge` instead of `npx agent-bridge`. The unscoped `agent-bridge` on npm is an unrelated package, so `npx agent-bridge` without this package installed downloads and runs someone else's code.
