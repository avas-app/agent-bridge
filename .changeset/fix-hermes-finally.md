---
'@avasapp/agent-bridge': patch
---

Fix "undefined is not a function" on Hermes when dispatching bridge.ping or bridge.pending: guard the finally callback and turn a rejected dispatch into an error result in both transports.
