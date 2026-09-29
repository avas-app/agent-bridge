---
'@avasapp/agent-bridge': minor
---

Tool arguments no longer go wrong silently when a JSON array is spread into them. `query.get`, `query.refetch`, `query.list`, `query.invalidate` and `query.unpin` take a key flat (`["todos", 1]`) or wrapped (`[["todos", 1]]`). `query.get` errors on a query that isn't cached, with similar keys, instead of returning null. `query.refetch` returns `{ matched, data }` and errors when nothing matches. `query.list` adds `isStale`, `isInvalidated`, `dataUpdatedAt`, `errorUpdatedAt` and `fetchStatus`, and takes a key prefix. `store.get` takes its path as a dotted string, an array of segments or separate arguments, and a last `{ pick: [...] }` or `{ keys: true }` returns only some fields. A tool definition can set `maxArgs` so a call with extra arguments fails; the `query.*` and `store.*` tools that take a fixed number do. In flows, `step` treats a single array as the argument list, as the CLI does.
