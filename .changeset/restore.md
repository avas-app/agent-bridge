---
'@avasapp/agent-bridge': minor
---

- `bridge.restore` undoes what the agent changed by running every tool named `*.restore`, in name order, and reports each result or error.
- New `query.restore`, `store.restore` and `mmkv.restore` unpin and refetch queries, put back store state from before `store.set`/`store.call`, and put back MMKV keys from before `mmkv.set`/`mmkv.delete`.
