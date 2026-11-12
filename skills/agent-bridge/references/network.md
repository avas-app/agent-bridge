# Network mocks and logs

```sh
npx @avasapp/agent-bridge call net.mock '["/inbox", {"status": 500}]'   # or {"offline": true}
npx @avasapp/agent-bridge call net.log '[{"since": 1700000000000}]'     # entries carry startedAt (epoch ms)
npx @avasapp/agent-bridge call net.entry 3                              # one request: bodies whole, headers (credential headers such as Authorization, Cookie, *-token, *-api-key cut unless {"full": true} second)
npx @avasapp/agent-bridge call net.waitFor '[{"path": "/orders", "method": "POST"}, {"timeoutMs": 5000}]'  # wait for it to finish
npx @avasapp/agent-bridge call net.mockFromLog '[3, {"user": {"name": "Moss"}}]'  # a real response, patched
npx @avasapp/agent-bridge call net.mocks '[{"full": true}]'             # active mocks; bodies over ~2 KB are cut unless full
```

`net.log` cuts bodies at about 2 KB; use `net.entry <id>` (or `{"full": true}`)
for the whole thing.

The newest mock is tried first, so a later broad mock shadows an earlier
specific one: give the specific one `{"priority": 1}` as `net.mock`'s third
argument, or read `shadows` in its result.

## What a mock matches

A string is a URL substring: `"/orders"` also answers `/orders/5/items`. For
exact matches use the object form (every key given must match):

```sh
call net.mock '[{"path": "/orders/:id"}, {"json": {"id": 5}}]'                 # whole path, any host, query ignored; * is the rest
call net.mock '[{"graphql": "GetUser"}, {"json": {"data": {}}}]'               # operationName in the POST body or ?operationName=
call net.mock '[{"path": "/search", "body": {"filter": {"status": "open"}}}, {"json": []}]'  # JSON body contains this
```

`path` ignores case and the query, takes `:name` only as a whole segment (`/items:batchGet` is literal), and a trailing slash is optional; spaces are refused (write `%20`). A mock with only `body` or `graphql` looks at every request. `body` matches objects by key (extra keys are fine) and arrays by length and
position; form and binary bodies never match. A batched GraphQL array body
isn't matched by `graphql`; use `body`. `net.mockFromLog` returns a `warning` when a POST body wasn't kept and the mock may answer other operations. The reply's `matches` says it in words.
`net.waitFor` takes the same match; pass `{"sinceId": <id from net.log>}` so an
older request doesn't satisfy it.

For a mock body too big for the command line, pass it as `@file`; see
[large-data.md](large-data.md).

## Strict network mode

A local scenario usually turns on strict network mode: any request no mock
answers fails with a 501, and the reply carries an error that names it
(`! error during …: agent-bridge strict network: no mock for GET https://…`).
Add a mock for it (`net.mock`), don't turn strict mode off.

`npx @avasapp/agent-bridge call net.strict` lists what it blocked. Strict mode
sees JS `fetch`/XHR only, not images, WebSockets or native SDKs.

## Mocks and cached queries

`bridge.restore` removes agent mocks and resets queries that hold data a mock
produced. Details in [restore.md](restore.md).
