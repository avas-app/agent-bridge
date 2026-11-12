# What restore undoes

```sh
npx @avasapp/agent-bridge call bridge.pending      # what restore will put back, per area
npx @avasapp/agent-bridge session stop --dry-run   # the same, and keeps the session
npx @avasapp/agent-bridge session stop             # runs bridge.restore
npx @avasapp/agent-bridge session stop --keep      # leaves the app as is; warns about anything still pending
```

`bridge.restore` unpins queries, puts back store, MMKV, AsyncStorage and SecureStore values, removes
network mocks, unmutes realtime channels and ends a faked connection state,
then undoes active scenarios (newest first), so the next run starts from the
real state. With `session stop --keep`, a later restore will still apply what
is pending.

A JS reload throws away the app's undo state. In a session, what lives in
storage is kept: `mmkv.set`/`mmkv.delete` of string values and `store.set`/
`store.call` on a persisted zustand store (one made with `persist`) are still
undone by `bridge.restore` after the reload, and the next call says
`app reloaded; kept N undos across the reload (...)`. A value the app changed
after your write is left alone and named. Everything else (stores that are not
persisted, redux, jotai, AsyncStorage and SecureStore changes, queries, mocks, `onRestore`) is lost: the session warns
`app reloaded; N pending restores lost: ...`. Redo that setup when you see it. After a reload that also lost non-persisted changes, check `bridge.pending`: `kept N undos` does not list what was lost in the same area. `not kept across reload: store:key` means that key (a Set, Date, class instance, one `partialize` renames, or one `redact` hides) is not journaled, so the reload keeps the agent's value for it; `could not re-arm after the reload: ...` means a store or MMKV instance never became ready and its undo was dropped; `<tool> was cut off; ... that undo may be lost` means a write's reply was lost and may not be journaled.
AsyncStorage and SecureStore values stay on disk across a reload with their old values gone, so run `bridge.restore` before `app.reload`. A key the app wrote after the agent did is left alone and returned under `skipped`.

## Mocked queries

Restore also resets queries that hold data a `net.mock` produced
(`query.restore` reports `mockedCleared`), so fake data can't survive a failing
real refetch. Only agent mocks are tracked, not app or scenario mocks.

A query counts as mocked when a request its queryFn started synchronously was
answered by a mock. A request started later (after an await, behind an async
interceptor, in a retry) can't be tied to a query, so every query fetching at
that moment is marked; on restore those reset even if real, and an observed one
refetches once. Infinite queries stay marked until reset.

## Store snapshots

A store is snapshotted on its first `store.set` or `store.call` since the last
restore, so a UI tap before that is not in the snapshot, and repairing a value
with `store.set` snapshots the broken one.

- If a value looks wrong: read `bridge.pending`, then `store.commit '"<store>"'`
  keeps the current value and drops the snapshot.
- `store.set <store> {}` arms the snapshot before you drive the UI.

## WebViews

`webview.press`, `fill` and `send` change the page and app, and restore does
not undo them: `webview.restore` only clears the message log. See
[webview.md](webview.md).

## App tools

The app may expose its own tools for hooks the bridge has no tool for
(`queue.flush`, `realtime.reconnect`); `tools` lists them. Whatever they change
through `onRestore` is undone by `bridge.restore` and listed under `app` in
`bridge.pending`. There is no `app.eval`: if the app has no tool for it, say so.
