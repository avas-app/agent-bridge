---
'@avasapp/agent-bridge': patch
---

A session no longer runs a call twice when its reply is lost (the app reloaded or the connection dropped mid-call). Read-only tools such as `screen.snapshot`, `screen.waitFor` and `store.get` are repeated on the new connection; any other tool fails with `the app reloaded during <tool>; it may or may not have run`, with the reload warning attached. The session's 5 s health check no longer takes the app's logged errors, so they reach the next real call tagged with the tool they followed, not `bridge.ping`. A `timeoutMs` in a tool's arguments longer than the call timeout (`screen.waitFor '["Done", {"timeoutMs": 15000}]'`) now stretches it, in the CLI, sessions and `connect()`, so the app's own timeout error arrives first.
