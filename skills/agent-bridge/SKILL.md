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
had something to undo) as a warning on the next call (also on a failed one) and again in `session stop`. When you see
it, redo your setup: nothing you changed before the reload will be undone.

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
`bridge.restore` (and `session stop`) undoes it after everything else. A local
scenario usually turns on strict network mode: any request no mock answers
fails with a 501, and the reply carries an error that names it
(`! error during …: agent-bridge strict network: no mock for GET https://…`).
Add a mock for it (`net.mock`), don't turn strict mode off.
`npx agent-bridge call net.strict` lists what it blocked. Strict mode sees JS
`fetch`/XHR only, not images, WebSockets or native SDKs.

If the app has no scenario for the state you need, say so. Don't sign in to a
real account instead.

## See and use the screen

```sh
npx agent-bridge call screen.snapshot                          # buttons, inputs, text on screen
npx agent-bridge call screen.findText "Payment"                 # text or accessibility label; {"labels":false} for text only
npx agent-bridge call screen.press '"add-plant"'               # by testID, label or text
npx agent-bridge call screen.press '[{"at":[350,60]}]'          # icon-only button: by point; {"index":1} picks among matches; {"force":true} presses disabled
npx agent-bridge call screen.fill '["plant-name", "Fern"]'     # runs the input's handlers
npx agent-bridge call screen.waitFor '"Name is required"'      # {"gone": true} waits for it to go
```

`press` and `fill` return once the app has rendered the result, so the next
check sees it. `fill` skips the keyboard: autocorrect and native-only input
behaviour need one real typing step from agent-device.

## Get the app into a state

```sh
npx agent-bridge call query.pin '[["features"], <data>]'       # stays through refetches
npx agent-bridge call store.call '["settings", "setTheme", "dark"]'
npx agent-bridge call router.navigate /inbox
npx agent-bridge call router.current
npx agent-bridge call net.mock '["/inbox", {"status": 500}]'   # or {"offline": true}
npx agent-bridge call net.log '[{"since": 1700000000000}]'     # entries carry startedAt (epoch ms)
npx agent-bridge call net.entry 3                              # one request, bodies whole
npx agent-bridge call net.mockFromLog '[3, {"user": {"name": "Moss"}}]'  # a real response, patched
```

`net.log` cuts bodies at about 2 KB; use `net.entry <id>` (or `{"full": true}`)
for the whole thing. The newest mock is tried first, so a later broad mock
shadows an earlier specific one: give the specific one `{"priority": 1}` as
`net.mock`'s third argument, or read `shadows` in its result.

Arguments are a JSON array (or a single JSON value): the array is spread into
the tool's arguments. Read the current value first and change only what you need:

```sh
npx agent-bridge call query.get '["todos", 1]'             # a flat key or '[["todos", 1]]'
npx agent-bridge call query.list '["todos"]'               # key prefix; shows isStale, isInvalidated, fetchStatus
npx agent-bridge call query.refetch '["todos"]'            # {matched, data}; errors when nothing matches
npx agent-bridge call store.get '["app", "auth.isLoggedIn"]'   # or ["app","auth","isLoggedIn"]
npx agent-bridge call store.get '["app", {"pick": ["auth.isLoggedIn", "settings.fontScale"]}]'
npx agent-bridge call store.get '["app", {"keys": true}]'  # top-level keys and types, no values
```

`query.get` errors on a key that is not cached (with similar keys), so a
`null` reply means the data is undefined. `query.refetch` replies
`{matched, refetched, data}`. `query.set` and `query.pin` need the key as an
array (`'[["todos"], <data>]'`). `query.set`, `query.pin`, `query.unpinAll`,
`query.restore`, `store.list` and `store.restore` fail when given more
arguments than they take; other tools may ignore extras. In a flow, `step`
takes the same shapes as `call`: `step('press', 'screen.press', 'Confirm')`, or
one array as the argument list. To pass one array as the only argument, wrap
it: `step('s', 'cart.setItems', [[a, b]])`.

## Realtime messages

If the app has `realtime.*` tools, you can see its realtime messages and fake
them instead of waiting for a backend to send one:

```sh
npx agent-bridge call realtime.channels                         # what the app listens on
npx agent-bridge call realtime.log '{"channel": "chat"}'        # recent messages, real and faked
npx agent-bridge call realtime.mute '"chat"'                    # stop real ones overwriting your state
npx agent-bridge call realtime.emit '["chat", {"name": "message", "data": {"text": "hi"}}]'
npx agent-bridge call realtime.connection '"disconnected"'      # null goes back to the real state
```

Copy the shape of a real message from `realtime.log` before you emit one. With
Ably, pass `{ name, data }`; with socket.io, pass the arguments after the
channel (the event name). Muting still lets your emitted messages through.
`emit` fails and lists the live channels when nothing listens on yours: open
the screen that subscribes first.

## Watch for errors

Every reply carries errors the app logged or threw since the previous reply,
printed as `! error during <tool>` or `! error after <tool>`. Treat them as
failures of the step they name. `npx agent-bridge call bridge.logs` shows the
last 200 errors and warnings.

## Repeat without the model

Write the steps into a flow file and run it:

```js
export const scenario = 'signedIn'   // applied first, undone after, even on failure

export default async ({ step }) => {
  await step('open form', 'screen.press', 'add-plant')
  await step('save empty', 'screen.press', 'save-plant')
  await step('error shown', 'screen.waitFor', 'Name is required')
  await step('undo', 'bridge.restore')
}
```

```sh
npx agent-bridge run flow.mjs --strict    # --strict fails if the app logged an error
npx agent-bridge run flow.mjs --scenario signedIn   # add a scenario the flow doesn't declare
```

## Clean up

```sh
npx agent-bridge session stop             # runs bridge.restore; --keep leaves the app as is
```

`bridge.restore` unpins queries, puts back store and MMKV values, removes
network mocks, unmutes realtime channels and ends a faked connection state,
then undoes active scenarios, so the next run starts from the real state.

## Traps

- Run next to the simulator. From another machine every call pays the network.
- It can't see native UI (system alerts, permission prompts, native sheets) or
  overlap. Finish a flow with one real UI check or screenshot from agent-device.
- With several apps on one Metro, pass `--device`.
