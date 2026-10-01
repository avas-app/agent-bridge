---
name: agent-bridge
description: "Drive a running React Native or Expo dev build directly through @avasapp/agent-bridge: start from an app-defined scenario such as a locally signed-in user, see what's on screen, fill in forms, press buttons, seed query data, flip feature flags, set store state, navigate, mock the network, fake realtime messages and undo it all, in milliseconds per call instead of tapping through the app. Pairs with agent-device, which opens the app and covers native UI, real taps and screenshots. Use whenever you need the app in a particular state to test a change, or need to verify what a screen shows."
---

# Driving an app with agent-bridge

The app mounts `useAgentBridge({ tools })` in a dev build. You call those tools
by name. Nothing is tapped, so there is no setup to click through.

## Pair it with agent-device

agent-bridge works inside the app's JavaScript; agent-device works the device.
Use both, each for what it's good at:

| agent-bridge | agent-device |
| --- | --- |
| Put the app in a state: flags, query data, store values, network mocks, realtime messages | Install and open the app, reload, relaunch |
| Navigate, fill forms, press buttons, check text on screen | System alerts, permission prompts, native sheets, the keyboard |
| Undo it all with `bridge.restore` | Screenshots, recordings, one real tap to prove the UI responds |

A typical run: `agent-device open` the app, set up and check the screen with
agent-bridge, then finish with one real tap or a screenshot from agent-device.
Don't tap through setup screens or edit backend data to reach a state that one
bridge call can set.

## Run the CLI directly

The examples say `npx agent-bridge` for brevity. Prefer the installed bin,
`./node_modules/.bin/agent-bridge` (or `bunx agent-bridge`): `npx` loads npm's
config on every call, so a project `.npmrc` with keys npm doesn't know prints
`npm warn Unknown project config` into your output each time, and it adds
roughly 200 ms more startup per call (machine-dependent).

## Start a session

```sh
npx agent-bridge session start            # add --metro host:port if Metro isn't on localhost:8081
npx agent-bridge tools                    # what this app exposes
```

A session holds one connection for all your calls. It stops itself after 15
minutes without calls and runs `bridge.restore` when it does.

A JS reload (an error screen's Retry, or `app.reload`) throws away every pending
restore. The session notices the app is a new runtime and reports
`app reloaded; N pending restores lost: store, query` (the areas that
had something to undo) as a warning on the next call (also on a failed one) and
again in `session stop`. When you see it, redo your setup: nothing you changed
before the reload will be undone.

If a call fails with `app not connected; reconnecting` or `The app is gone`, the
session lost the app (Metro or the app is down, or mid-reload). It retries on
its 5 s health check and on your next call: wait a few seconds and call again.
`session stop` still works.

If `tools` fails with "agent-bridge isn't running", the hook isn't mounted in
this build. Say so; don't fall back to tapping silently.

## Start from a scenario

Apps can define named setups, such as a locally signed-in user. Use one
instead of signing in by hand or seeding auth state yourself:

```sh
npx agent-bridge scenarios                                        # what this app defines
npx agent-bridge call scenario.apply '["signedIn", {"user": {"name": "Ada"}}]'
```

`scenarios` shows each one's options as a JSON Schema. Bad options fail
before anything changes, and the error lists every problem
(`options: unknown option "usr". Known: user`): fix them and apply again.
`bridge.restore` (and `session stop`) undoes it after everything else.

A local scenario usually turns on strict network mode: any request no mock
answers fails with a 501, and the reply carries an error that names it
(`! error during …: agent-bridge strict network: no mock for GET https://…`).
Add a mock for it (`net.mock`), don't turn strict mode off.

If the app has no scenario for the state you need, say so. Don't sign in to a
real account instead. If you're asked to add one, read
[references/writing-scenarios.md](references/writing-scenarios.md).

## See and use the screen

```sh
npx agent-bridge call screen.snapshot                       # buttons, inputs, text on the focused screen
npx agent-bridge call screen.press '"add-plant"'            # by testID, label or text
npx agent-bridge call screen.fill '["plant-name", "Fern"]'  # runs the input's handlers
npx agent-bridge call screen.waitFor '"Name is required"'   # {"gone": true} waits for it to go
npx agent-bridge call router.navigate /inbox
```

`press` and `fill` return once the app has rendered the result, so the next
check sees it. Arguments are a JSON array (or a single JSON value): the array is
spread into the tool's arguments.

## Watch for errors

Every reply carries errors the app logged or threw since the previous reply,
printed as `! error during <tool>` or `! error after <tool>`. Treat them as
failures of the step they name. `npx agent-bridge call bridge.logs` shows the
last 200 errors and warnings.

## Clean up

```sh
npx agent-bridge call bridge.pending      # what restore will put back, per area
npx agent-bridge session stop             # runs bridge.restore; --keep leaves the app as is
```

`bridge.restore` unpins queries, puts back store values, removes network mocks,
unmutes realtime channels, then undoes active scenarios, so the next run starts
from the real state.

## Read more when you need it

| When you need to… | Read |
| --- | --- |
| Press icon-only buttons, scroll, pull to refresh, find text, take a screenshot | [references/screen.md](references/screen.md) |
| Drive or read a page inside a WebView (`webview "…"` in the snapshot) | [references/webview.md](references/webview.md) |
| Read or set query data, store values, routes, modals; get argument shapes right | [references/state.md](references/state.md) |
| Mock or inspect requests, or deal with strict network mode | [references/network.md](references/network.md) |
| See or fake realtime messages (`realtime.*` in `tools`) | [references/realtime.md](references/realtime.md) |
| Handle a result over 32 KB or an argument over ~128 KB | [references/large-data.md](references/large-data.md) |
| Run many calls at once, write a flow file, or measure timing | [references/flows.md](references/flows.md) |
| Understand what restore undoes, or fix a value restore got wrong | [references/restore.md](references/restore.md) |
| Add a scenario to the app | [references/writing-scenarios.md](references/writing-scenarios.md) |

The app may expose its own tools for hooks the bridge has no tool for
(`queue.flush`, `realtime.reconnect`); `tools` lists them. There is no
`app.eval`: if the app has no tool for it, say so.

## Caveats

- It can't see native UI (system alerts, permission prompts, native sheets) or
  overlap. Finish a flow with one real UI check or screenshot from agent-device.
- `fill` skips the keyboard: autocorrect and native-only input behaviour need
  one real typing step from agent-device.
- With several apps on one Metro, pass `--device`.
