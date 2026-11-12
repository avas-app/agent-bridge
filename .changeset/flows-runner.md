---
'@avasapp/agent-bridge': minor
---

`agent-bridge run` now runs several flows: pass files, a directory (its `*.flow.mjs`) or a glob (globs only match `*.flow.mjs`), and it runs them in order on one connection, prints a pass/fail line for each and a summary, and exits 1 if any failed. `--bail` stops at the first failure, `--grep <text>` picks flows by name or by path relative to where you ran, `--keep` leaves the app as a flow left it, and `--reporter json|junit` writes a report for CI: on stdout (with step lines and a flow's `console.log` on stderr) or to a file with `--out <file>`, which needs `--reporter`. A flow file that won't load, a failed connect and a `--grep` with no match show up as failed testcases in the report instead of crashing before it. JUnit uses the folder as the classname and relative file paths, so same-named flows in different folders stay apart.

Behaviour change: every flow now ends with `bridge.restore`, not only flows that declare a scenario, so a failed flow can't leave the app dirty for the next one. Through a session this also undoes changes you made by hand before `run`; pass `--keep` to skip it. `runFlow` does the same (`{ keep: true }` opts out). A flow's own `step('undo', 'bridge.restore')` is no longer needed. Errors the closing restore reports are printed but don't count for `--strict`.

Running one flow now also shows that closing `restore` step. If the app stops answering, the error is printed at once and the remaining flows are skipped with that reason.

Flows get an `expect` helper (`expect.text`, `expect.gone`, `expect.route`, `expect.result`) that fails with a readable message (`expect.result` takes a `RegExp` to match a string and rejects `Date`, `Map` and other class instances), and a failed flow prints what was on screen (`screen.snapshot` and `router.current`).
