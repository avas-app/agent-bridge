# Contributing

```sh
bun install
bun run check   # typecheck, tests, build, and the release-gate check
```

- Tests live next to the code in `__tests__`. Client changes need a test against the fake Metro in `src/client/__tests__/fake-metro.ts`.
- A new adapter goes in `src/adapters/`, with a production stub in `src/noop/`, an entry in `entries/`, and a subpath in `package.json`. `bun run check:gates` fails if the stub misses an export.
- Anything users would notice gets a changeset: `bun run changeset`.
- Open an issue before a large change so we can agree on the shape first.

## Issue titles

Start an issue title with the area of `src/` the fix would touch, in brackets:

| Prefix | Code |
|---|---|
| `[core/screen]` | `src/runtime/screen`, `src/runtime/find-text-core.ts` |
| `[core/runtime]` | the rest of `src/runtime` and the built-in tools |
| `[core/restore]` | undo and restore tracking (`bridge.restore`, `session stop`) |
| `[client/cli]` | `src/cli.ts`, `src/client/flow.ts` |
| `[client/session]` | `src/client/session`, `src/client/discover.ts` |
| `[network]` | `src/network` |
| `[realtime]` | `src/realtime` |
| `[adapter/<name>]` | `src/adapters/<name>.ts`, e.g. `[adapter/zustand]` |

For example: `[adapter/zustand] store.set prints the whole store`. If an issue covers two areas, split it.
