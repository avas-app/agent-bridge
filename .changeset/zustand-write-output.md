---
'@avasapp/agent-bridge': patch
---

`store.set` returns only the keys it set, and `store.call` returns the action's own result or `{ changed }` instead of the whole store, so auth tokens are no longer echoed. `storeTools(stores, { redact })` masks paths (or runs a hook) on every `store.*` output.
