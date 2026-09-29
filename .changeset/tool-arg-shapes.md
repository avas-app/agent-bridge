---
'@avasapp/agent-bridge': minor
---

Tool arguments no longer go wrong silently when a JSON array is spread into them. `query.get`, `query.refetch`, `query.list`, `query.invalidate` and `query.unpin` take a key flat (`["todos", 1]`) or wrapped (`[["todos", 1]]`). `query.list` adds `isStale`, `isInvalidated`, `dataUpdatedAt`, `errorUpdatedAt` and `fetchStatus`, and takes a key prefix. `store.get` takes its path as a dotted string, an array of segments or separate arguments, and a last `{ pick: [...] }` or `{ keys: true }` returns only some fields. `query.set` and `query.pin` reject a key that isn't an array. A tool definition can set `maxArgs` so a call with extra arguments fails; `query.set`, `query.pin`, `query.unpinAll`, `query.restore`, `store.list` and `store.restore` do, other tools are unchanged.

Breaking changes:

- `query.get` errors on a query that isn't cached (with similar keys) instead of returning null.
- `query.refetch` returns `{ matched, refetched, data }` instead of the data, and errors when nothing matches or nothing can be refetched.
- In flows, `step` treats a single array argument as the whole argument list, as `agent-bridge call` does. A step that passed one array to a tool, `step('s', 'cart.setItems', [a, b])`, now spreads it; wrap it to keep the old behaviour: `[[a, b]]`. `call` is unchanged.
