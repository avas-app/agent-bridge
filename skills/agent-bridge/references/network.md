# Network mocks and logs

```sh
npx agent-bridge call net.mock '["/inbox", {"status": 500}]'   # or {"offline": true}
npx agent-bridge call net.log '[{"since": 1700000000000}]'     # entries carry startedAt (epoch ms)
npx agent-bridge call net.entry 3                              # one request, bodies whole
npx agent-bridge call net.mockFromLog '[3, {"user": {"name": "Moss"}}]'  # a real response, patched
npx agent-bridge call net.mocks '[{"full": true}]'             # active mocks; bodies over ~2 KB are cut unless full
```

`net.log` cuts bodies at about 2 KB; use `net.entry <id>` (or `{"full": true}`)
for the whole thing.

The newest mock is tried first, so a later broad mock shadows an earlier
specific one: give the specific one `{"priority": 1}` as `net.mock`'s third
argument, or read `shadows` in its result.

For a mock body too big for the command line, pass it as `@file`; see
[large-data.md](large-data.md).

## Strict network mode

A local scenario usually turns on strict network mode: any request no mock
answers fails with a 501, and the reply carries an error that names it
(`! error during …: agent-bridge strict network: no mock for GET https://…`).
Add a mock for it (`net.mock`), don't turn strict mode off.

`npx agent-bridge call net.strict` lists what it blocked. Strict mode sees JS
`fetch`/XHR only, not images, WebSockets or native SDKs.

## Mocks and cached queries

`bridge.restore` removes agent mocks and resets queries that hold data a mock
produced. Details in [restore.md](restore.md).
