# Contributing

```sh
bun install
bun run check   # typecheck, tests, build, and the release-gate check
```

- Tests live next to the code in `__tests__`. Client changes need a test against the fake Metro in `src/client/__tests__/fake-metro.ts`.
- A new adapter goes in `src/adapters/`, with a production stub in `src/noop/`, an entry in `entries/`, and a subpath in `package.json`. `bun run check:gates` fails if the stub misses an export.
- Anything users would notice gets a changeset: `bun run changeset`.
- Open an issue before a large change so we can agree on the shape first.
