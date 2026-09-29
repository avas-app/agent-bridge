---
'@avasapp/agent-bridge': minor
---

Show what `bridge.restore` will undo and let apps add their own undos. New `bridge.pending` lists each area's pending restore (for stores, the snapshot against the current value, redacted and truncated). `session stop --dry-run` prints the same and keeps the session; `session stop --keep` warns about snapshots still pending. New `store.commit` drops a store's snapshot so the current value becomes the baseline. New `onRestore(fn, label?)` export registers an undo from an app tool; `bridge.restore` runs it once via the new `app.restore`, and `bridge.pending` lists it under `app`. The store tool descriptions now say when the snapshot is taken.
