# What restore undoes

```sh
npx agent-bridge call bridge.pending      # what restore will put back, per area
npx agent-bridge session stop --dry-run   # the same, and keeps the session
npx agent-bridge session stop             # runs bridge.restore
npx agent-bridge session stop --keep      # leaves the app as is; warns about anything still pending
```

`bridge.restore` unpins queries, puts back store and MMKV values, removes
network mocks, unmutes realtime channels and ends a faked connection state,
then undoes active scenarios (newest first), so the next run starts from the
real state. With `session stop --keep`, a later restore will still apply what
is pending.

A JS reload throws away every pending restore; the session warns
`app reloaded; N pending restores lost`. Redo your setup when you see it.

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
