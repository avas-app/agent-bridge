# Query data, store state and navigation

## Set state

```sh
npx agent-bridge call query.pin '[["features"], <data>]'       # stays through refetches
npx agent-bridge call store.call '["settings", "setTheme", "dark"]'
npx agent-bridge call router.navigate /inbox
npx agent-bridge call router.current
npx agent-bridge call router.dismiss                            # closes a route-based modal
```

`router.back` only pops the navigator: an in-app modal or sheet the app renders
itself stays open and the screen under it is popped. Close those with the app's
own tool (e.g. `modal.close`) if it has one; check `tools` first.

## Read before you change

Read the current value first and change only what you need:

```sh
npx agent-bridge call query.get '["todos", 1]'             # a flat key or '[["todos", 1]]'
npx agent-bridge call query.list '["todos"]'               # key prefix; shows isStale, isInvalidated, fetchStatus
npx agent-bridge call query.refetch '["todos"]'            # {matched, refetched, data}; errors when nothing matches
npx agent-bridge call store.get '["app", "auth.isLoggedIn"]'   # or ["app","auth","isLoggedIn"]
npx agent-bridge call store.get '["app", {"pick": ["auth.isLoggedIn", "settings.fontScale"]}]'
npx agent-bridge call store.get '["app", {"keys": true}]'  # top-level keys and types, no values
```

`query.get` errors on a key that is not cached (with similar keys), so a
`null` reply means the data is undefined. For a large query, narrow it with
`pages` or `path`; see [large-data.md](large-data.md).

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
