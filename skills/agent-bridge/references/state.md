# Query data, store state and navigation

## Set state

```sh
npx @avasapp/agent-bridge call query.pin '[["features"], <data>]'       # stays through refetches
npx @avasapp/agent-bridge call store.call '["settings", "setTheme", "dark"]'
npx @avasapp/agent-bridge call router.navigate /inbox
npx @avasapp/agent-bridge call router.current                            # React Navigation apps: nav.navigate Inbox, nav.current
npx @avasapp/agent-bridge call router.dismiss                            # closes a route-based modal
```

`router.back` only pops the navigator: an in-app modal or sheet the app renders
itself stays open and the screen under it is popped. Close those with the app's
own tool (e.g. `modal.close`) if it has one; check `tools` first.

## Read before you change

Read the current value first and change only what you need:

```sh
npx @avasapp/agent-bridge call query.get '["todos", 1]'             # a flat key or '[["todos", 1]]'
npx @avasapp/agent-bridge call query.list '["todos"]'               # key prefix; shows isStale, isInvalidated, fetchStatus
npx @avasapp/agent-bridge call query.refetch '["todos"]'            # {matched, refetched, data}; errors when nothing matches
npx @avasapp/agent-bridge call store.get '["app", "auth.isLoggedIn"]'   # or ["app","auth","isLoggedIn"]
npx @avasapp/agent-bridge call store.get '["app", {"pick": ["auth.isLoggedIn", "settings.fontScale"]}]'
npx @avasapp/agent-bridge call store.get '["app", {"keys": true}]'  # top-level keys and types, no values
```

`query.get` errors on a key that is not cached (with similar keys), so a
`null` reply means the data is undefined. For a large query, narrow it with
`pages` or `path`; see [large-data.md](large-data.md).

## Redux and Jotai

Same ideas under their own prefixes, so a Zustand `store.*` and these can coexist.

```sh
npx @avasapp/agent-bridge call redux.list
npx @avasapp/agent-bridge call redux.get '["auth", "user.name"]'      # or [] for the whole state
npx @avasapp/agent-bridge call redux.dispatch '[{"type":"cart/add","payload":"apple"}]'
npx @avasapp/agent-bridge call redux.set '["auth", {"token": "abc"}]'  # merge into a slice
npx @avasapp/agent-bridge call jotai.list                              # read-write or read-only
npx @avasapp/agent-bridge call jotai.get '["user", "name"]'
npx @avasapp/agent-bridge call jotai.set '["count", 5]'                # writable atoms only
```

`redux.set` and restore need the app to wrap its root reducer in
`bridgeReducer()` (inside `persistReducer` with redux-persist); without it they
fail and say so. `redux.set` merges into object slices only. `redux.dispatch`
sends plain actions only. `jotai.set` refuses atoms whose value isn't the one
sent (action atoms, `atomWithReducer`). Redacted slices, atoms and paths print as `"[redacted]"`.

## Argument shapes

Arguments are a JSON array (or a single JSON value): the array is spread into
the tool's arguments.

- `query.set` and `query.pin` need the key as an array (`'[["todos"], <data>]'`).
- `query.set`, `query.pin`, `query.unpinAll`, `query.restore`, `store.list` and
  `store.restore` fail when given more arguments than they take; other tools may
  ignore extras.
- In a flow, `step` takes the same shapes as `call`:
  `step('press', 'screen.press', 'Confirm')`, or one array as the argument list.
  To pass one array as the only argument, wrap it:
  `step('s', 'cart.setItems', [[a, b]])`.

For how store changes are snapshotted and undone, see [restore.md](restore.md).
