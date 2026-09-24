---
name: agent-bridge
description: "Drive a running React Native or Expo dev build directly through @avasapp/agent-bridge: seed query data, flip feature flags, set store state, navigate, and check what's on screen in about a millisecond per call, instead of tapping through the app. Use whenever you need the app in a particular state to test a change, or need to verify what a screen shows."
---

# Driving an app with agent-bridge

The app mounts `useAgentBridge({ tools })` in a dev build. You call those tools
by name. Nothing is tapped, so there is no setup to click through.

## Find the app and its tools

```sh
npx agent-bridge devices                 # add --metro host:port if Metro isn't on localhost:8081
npx agent-bridge tools                   # add --device <name> if several apps are listed
```

If `tools` fails with "agent-bridge isn't running", the hook isn't mounted in
this build. Say so; don't fall back to tapping silently.

## Get the app into a state

```sh
npx agent-bridge call query.pin '[["features:bulk"], <data>]'   # stays through refetches
npx agent-bridge call store.call '["settings", "setColorScheme", "dark"]'
npx agent-bridge call router.navigate /inbox
```

Arguments are a JSON array (or a single JSON value). Read the current value
first (`query.get`, `store.get`) and change only what you need.

## Check the screen

```sh
npx agent-bridge call screen.findText '"Agent Ride"'
```

`onScreen: 1` means rendered, displayed, inside the window, and not on a hidden
tab. It can't see overlap, opacity or native UI (system alerts, native sheets,
maps). Finish a flow with one real UI check or screenshot from your device tool.

## Repeat without the model

Write the steps into a flow file and run it:

```js
export default async ({ step }) => {
  await step('flag off', 'query.pin', ['features:bulk'], data)
  await step('open Inbox', 'router.navigate', '/inbox')
  await step('check', 'screen.findText', 'Seeded by the agent')
}
```

```sh
npx agent-bridge run flow.mjs
```

## Clean up

Unpin what you pinned (`query.unpinAll`) and restore any store values you
changed, so the next run starts from the real state.

## Traps

- Run next to the simulator. From another machine every call pays the network.
- Back to back, a call waits for the app to finish rendering the last change.
  That's the app, not the bridge.
- With several apps on one Metro, pass `--device`.
