# The CLI, flows and the client

```sh
npx agent-bridge session start            # hold one connection; call/tools/run reuse it
npx agent-bridge tools
npx agent-bridge scenarios                # setups the app defines, e.g. signedIn
npx agent-bridge call scenario.apply '["signedIn", {"user": {"name": "Ada"}}]'
npx agent-bridge call query.pin '[["features"], {"beta": false}]'
npx agent-bridge call screen.press '"add-plant"'
npx agent-bridge call screen.fill '["plant-name", "Fiddle leaf fig"]'
npx agent-bridge call screen.waitFor '"Name is required"'
npx agent-bridge call query.get '["feed"]' --out feed.json   # big result to a file; prints size and shape
npx agent-bridge run flows/add-plant.mjs --strict   # fail if the app logged an error
npx agent-bridge session stop             # runs bridge.restore, then disconnects
npx agent-bridge session stop --dry-run   # lists what it would undo, keeps the session
```

**Skip npx for agents.** `npx` loads npm's config on every call. If the project's `.npmrc` has keys npm doesn't know, each call prints `npm warn Unknown project config …` into the agent's output, and npx adds process startup. The installed bin does neither: run `./node_modules/.bin/agent-bridge …` (or `bunx agent-bridge …`) in place of `npx agent-bridge` in every command here.

**Timing checks and long sequences.** Every CLI call is a new process, roughly 90–100 ms with the bin and 280–320 ms through `npx` on one Linux box ([benchmarks](benchmarks.md#cli-overhead)), all of it startup rather than the bridge. For a timing check, or more than a handful of calls, write a flow file and use `agent-bridge run`: it pays startup once and prints how long each step took.

```js
// flows/back-nav.mjs
export default async ({ step }) => {
  await step('open detail', 'router.navigate', '/plants/1')
  await step('go back', 'router.back')          // its time is printed in the step list
  await step('list shown', 'screen.waitFor', 'My plants')
}
```

```sh
./node_modules/.bin/agent-bridge run flows/back-nav.mjs   # one line per step: number, label, time
```

## Big results and arguments

`call` prints a result over 32 KB as a summary (`resultTooLarge`, size, shape, a hint) instead of flooding the terminal: pass `--out <file>` to write it to a file, or `--full` to print it. Flows and `connect()` always get the full value. To keep big values small at the source, `query.get` takes a last `{ pages: [from, to] }` (an infinite query's pages, `to` exclusive, with `totalPages`) or `{ path: "pages.0.items" }`, and `net.mocks` cuts response bodies over ~2 KB like `net.log` (`{ full: true }` returns them whole).

The shell caps one argument at about 128 KB on Linux (`Argument list too long`). `call <tool> @args.json` reads the arguments from a file, and `@-` from stdin, with the inline rules: an array is the argument list, any other JSON value is one argument. With several words each is one argument and `@feed.json` is that file's JSON as it is: `call net.mock '"/feed"' @feed.json`. A bare word that starts with `@` is always a path; write a string like that as JSON (`'"@user"'`). A missing file or invalid JSON fails before connecting and names the path. `call --batch` lines take `@file` as their whole argument list (relative to the cwd; `@-` isn't allowed there, stdin carries the calls).

## Batch and REPL

For a sequence of ad-hoc calls where a flow file is too much, `call --batch` reads one call per line from stdin (`tool args`, args as in `call`; blank lines and `#` lines are skipped; arguments that start like JSON but don't parse are reported as an error line rather than sent as a string) and prints one JSON line per call over a single connection:

```sh
printf '%s\n' 'router.navigate /inbox' 'screen.waitFor "Inbox"' | agent-bridge call --batch
# {"tool":"router.navigate","ok":true,"ms":1.8,"appMs":1,"value":{...}}
# {"tool":"screen.waitFor","ok":false,"ms":2003.1,"error":"..."}
```

`ms` is the client's round trip and `appMs` the time inside the app. `logs` and `notice` (what `call` prints on stderr) are added when present. It uses the running session under the same rules as `call`, or one direct connection. `--stop-on-error` stops at the first failed call; the exit code is 1 if any call failed. Results over 32 KB are summarised (`--full` prints them); `--out <dir>` (a new or empty directory) writes each call's full result to `<dir>/<n>-<tool>.json` and puts the file summary in `value`. Lines starting with `.` are the REPL's dot commands, run locally (`.tools`, `.time`, `.pending`, `.restore`, `.exit`), never sent to the app. Exiting early (`--stop-on-error`, or the reader closing stdout) doesn't wait for stdin.

`agent-bridge repl` is the same loop with a prompt: history (`~/.agent-bridge/repl_history`, last 500 lines, saved as you type), tab completion of tool names and dot commands, pretty-printed values with their timings, and errors in red. Dot commands: `.help`, `.tools [prefix]`, `.time <call> [xN]` (N runs, min/median/max), `.pending`, `.restore`, `.exit`. Ctrl-C clears the line, or, during a call or `.time`, stops waiting for it (the app may still finish the call); Ctrl-D or `.exit` leaves. `.time` runs at most 1000 times. When stdin is not a terminal, `repl` behaves exactly like `call --batch`, so piping into it is safe; prompt and colours also need stdout to be a terminal. `repl` takes no `--out`.

## Sessions

A session stops itself, restore included, after 15 minutes without calls (`--idle`), and reconnects if the app reloads. After a reload it warns `app reloaded; N pending restores lost: store, query` (the areas that had something to undo) in the next call's output, failed or not, and in `session stop`, because the old runtime's undo state is gone. Every step of a reconnect is time-bounded (12 s per transport, Expo then CDP), so a Metro that stops answering can't wedge the session: calls fail with `app not connected; reconnecting` or `The app is gone (...)` instead of hanging, the daemon's health check (every 5 s) and the next call each try again until the idle timeout, and `session stop` and SIGTERM always finish (a stop still tries one reconnect so `bridge.restore` can run).

## From code

```ts
import { connect } from '@avasapp/agent-bridge/client'

const app = await connect({ metro: 'localhost:8081' })
await app.call('router.navigate', '/add')
await app.call('screen.fill', 'plant-name', 'Fiddle leaf fig')
await app.call('screen.press', 'save-plant')
```

`connect()` tries the Expo dev-tools socket first and falls back to CDP.

## Flows

A flow is a module the CLI runs without a model in the loop. `step(label, tool, ...args)` takes the arguments spread, or one array as the whole list, as `call` does:

```js
export const scenario = 'signedIn'   // optional: see scenarios.md

export default async ({ step }) => {
  await step('flag: beta off', 'query.pin', ['features'], { beta: false })
  await step('save empty form', 'screen.press', 'save-plant')
  await step('error shown', 'screen.waitFor', 'Name is required')
  await step('undo', 'bridge.restore')
}
```

To run flows from your own script or CI job, import them and pass them to `runFlow`. It applies declared [scenarios](scenarios.md), restores afterwards, and throws what the flow threw:

```ts
import { connect, runFlow } from '@avasapp/agent-bridge/client'
import * as mainTabs from './flows/main-tabs.flow.mjs'

const app = await connect({ metro: 'localhost:8081' })
const { errors, restoreErrors } = await runFlow(app, mainTabs, { scenarios: [{ name: 'signedIn' }] })
app.close()
if (errors || restoreErrors.length) process.exit(1)
```

No device tool is needed. Pair one (such as agent-device) with the bridge for what it can't reach: system alerts, permission prompts, the keyboard, screenshots, and one real tap per flow.
