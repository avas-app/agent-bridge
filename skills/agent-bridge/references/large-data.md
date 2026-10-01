# Big results and big arguments

## Big results

`call` prints results over 32 KB as a summary, not the value:
`{"resultTooLarge": true, "bytes", "size", "shape", "hint"}`. Add
`--out result.json` to write the whole result to a file (the command prints the
file, its size and the top-level shape), or `--full` to print it anyway. Flows
and `connect()` always get the full value.

Narrow the call before reaching for `--out`:

```sh
npx agent-bridge call query.get '["feed", {"pages": [0, 2]}]'          # first two pages of an infinite query, plus totalPages
npx agent-bridge call query.get '["feed", {"path": "pages.0.items"}]'  # just that value
npx agent-bridge call net.mocks '[{"full": true}]'   # net.mocks cuts bodies over ~2 KB unless full
```

`pages` is `[from, to]` with `to` exclusive, like `Array.slice`; `path` applies
after `pages` when both are given.

## Big arguments

The shell caps one argument at about 128 KB on Linux. For a bigger value (a long
feed, a large `net.mock` body), write JSON to a file and pass `@file`:

```sh
npx agent-bridge call query.pin @args.json                  # the file is the argument list, like the inline form
npx agent-bridge call net.mock '"/feed"' @feed.json         # several words: each is one argument; @file is its JSON as-is
some-generator | npx agent-bridge call store.set @-         # @- reads stdin
```

A file holding an array is the argument list; any other JSON value is one
argument. With several words, `@feed.json` is one argument even when it is an
array. A bare word starting with `@` is always a path, so pass a string like that
as JSON: `'"@user"'`. A missing file or invalid JSON fails before connecting and
names the path. Only one `@-` per call. `call --batch` lines take `@file` as their
whole argument list (paths relative to where you run it; not `@-`, stdin is the calls).
