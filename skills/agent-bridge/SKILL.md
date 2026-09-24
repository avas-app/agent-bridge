---
name: agent-bridge
description: "Drive a running React Native or Expo dev build directly through @avasapp/agent-bridge: see what's on screen, fill in forms, press buttons, seed query data, flip feature flags, set store state, navigate, mock the network and undo it all, in milliseconds per call instead of tapping through the app. Use whenever you need the app in a particular state to test a change, or need to verify what a screen shows."
---

# Driving an app with agent-bridge

The app mounts `useAgentBridge({ tools })` in a dev build. You call those tools
by name. Nothing is tapped, so there is no setup to click through.

## Start a session

```sh
npx agent-bridge session start            # add --metro host:port if Metro isn't on localhost:8081
npx agent-bridge tools                    # what this app exposes
```

A session holds one connection for all your calls. It stops itself after 15
minutes without calls and runs `bridge.restore` when it does.

If `tools` fails with "agent-bridge isn't running", the hook isn't mounted in
this build. Say so; don't fall back to tapping silently.

## See and use the screen

```sh
npx agent-bridge call screen.snapshot                          # buttons, inputs, text on screen
npx agent-bridge call screen.press '"add-plant"'               # by testID, label or text
npx agent-bridge call screen.fill '["plant-name", "Fern"]'     # runs the input's handlers
npx agent-bridge call screen.waitFor '"Name is required"'      # {"gone": true} waits for it to go
```

`press` and `fill` return once the app has rendered the result, so the next
check sees it. `fill` skips the keyboard: autocorrect and native-only input
behaviour need one real typing step from your device tool.

## Get the app into a state

```sh
npx agent-bridge call query.pin '[["features"], <data>]'       # stays through refetches
npx agent-bridge call store.call '["settings", "setTheme", "dark"]'
npx agent-bridge call router.navigate /inbox
npx agent-bridge call router.current
npx agent-bridge call net.mock '["/inbox", {"status": 500}]'   # or {"offline": true}
npx agent-bridge call net.log
```

Arguments are a JSON array (or a single JSON value). Read the current value
first (`query.get`, `store.get`) and change only what you need.

## Watch for errors

Every reply carries errors the app logged or threw since the previous reply,
printed as `! error during <tool>` or `! error after <tool>`. Treat them as
failures of the step they name. `npx agent-bridge call bridge.logs` shows the
last 200 errors and warnings.

## Repeat without the model

Write the steps into a flow file and run it:

```js
export default async ({ step }) => {
  await step('open form', 'screen.press', 'add-plant')
  await step('save empty', 'screen.press', 'save-plant')
  await step('error shown', 'screen.waitFor', 'Name is required')
  await step('undo', 'bridge.restore')
}
```

```sh
npx agent-bridge run flow.mjs --strict    # --strict fails if the app logged an error
```

## Clean up

```sh
npx agent-bridge session stop             # runs bridge.restore; --keep leaves the app as is
```

`bridge.restore` unpins queries, puts back store and MMKV values and removes
network mocks, so the next run starts from the real state.

## Traps

- Run next to the simulator. From another machine every call pays the network.
- It can't see native UI (system alerts, permission prompts, native sheets) or
  overlap. Finish a flow with one real UI check or screenshot from your device tool.
- With several apps on one Metro, pass `--device`.
