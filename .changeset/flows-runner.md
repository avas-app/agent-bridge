---
'@avasapp/agent-bridge': minor
---

`agent-bridge run` now runs several flows: pass files, a directory (its `*.flow.mjs`) or a glob, and it runs them in order on one connection, prints a pass/fail line for each and a summary, and exits 1 if any failed. `--bail` stops at the first failure, `--grep <text>` picks flows by name, `--keep` leaves the app as a flow left it, and `--reporter json|junit` with `--out <file>` writes a report for CI.

Behaviour change: every flow now ends with `bridge.restore`, not only flows that declare a scenario, so a failed flow can't leave the app dirty for the next one. Through a session this also undoes changes you made by hand before `run`; pass `--keep` to skip it. `runFlow` does the same (`{ keep: true }` opts out). A flow's own `step('undo', 'bridge.restore')` is no longer needed.

Flows get an `expect` helper (`expect.text`, `expect.gone`, `expect.route`, `expect.result`) that fails with a readable message, and a failed flow prints what was on screen (`screen.snapshot` and `router.current`).
