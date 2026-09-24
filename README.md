# @avasapp/agent-bridge

Let coding agents drive a running React Native app directly. Seed data, flip flags, navigate and check the screen in **milliseconds**, without tapping through the app.

## Demo

![An agent hides a tab, turns on dark mode, fills in a form, seeds data, checks the screen and undoes it all](example/media/demo.gif)

<!-- TODO: upload example/media/demo-x.mp4 in GitHub's web editor and put the URL it gives here. GitHub only plays an mp4 uploaded that way. -->

[`example/flows/demo.mjs`](example/flows/demo.mjs) driving [the example app](example) in Expo Go, all on one Mac:

| Call | Round trip |
| --- | --- |
| `bridge.ping` | 1–4 ms |
| `screen.findText`, `screen.waitFor` (already there) | 3–9 ms |
| `screen.fill`, `screen.press` | 20–65 ms, render included |
| `query.pin`, `store.call`, `router.navigate` | 11–44 ms, render included |
| 14 steps, no pauses | 0.8 s wall, 0.4 s of it waiting on a save |

```
14 steps, all local on one Mac:   0.8 s wall with no pauses
same flow from another machine:   ~57 ms per call (network)
same screen check via a11y tree:  450–970 ms
```

Works on Expo (dev-tools socket) and on bare React Native (CDP over Metro). Dev builds only: release builds get empty stubs.

## Install

```sh
bun add -d @avasapp/agent-bridge   # or npm / yarn / pnpm
```

### Teach your agent

The package ships an agent skill that tells your agent when and how to drive the app. Add it to Claude Code, Cursor, Codex and other agents:

```sh
npx skills add avas-app/agent-bridge
```

In Claude Code you can install it as a plugin instead:

```
/plugin marketplace add avas-app/agent-bridge
/plugin install agent-bridge@agent-bridge
```

## In the app

Mount the hook in a file that only runs in development. You choose every tool; adapters for common libraries are one import away.

```tsx
import { cdpTransport, useAgentBridge } from '@avasapp/agent-bridge'
import { expoTransport } from '@avasapp/agent-bridge/expo'
import { queryTools } from '@avasapp/agent-bridge/tanstack-query'
import { storeTools } from '@avasapp/agent-bridge/zustand'
import { mmkvTools } from '@avasapp/agent-bridge/react-native-mmkv'
import { routerTools } from '@avasapp/agent-bridge/expo-router'
import { networkTools } from '@avasapp/agent-bridge/network'
import { router, useNavigationContainerRef } from 'expo-router'

export function AgentBridge() {
  const queryClient = useQueryClient()
  useAgentBridge({
    name: 'my-app',
    transports: [expoTransport(), cdpTransport()],
    tools: {
      ...queryTools(queryClient),
      ...storeTools({ settings: useSettingsStore, auth: useAuthStore }),
      ...mmkvTools({ storage }),
      ...routerTools(router, { navigation: useNavigationContainerRef() }),
      ...networkTools(),
      // Your own tools: any function, JSON in and out.
      'auth.signIn': (session) => signInWith(session),
    },
  })
  return null
}
```

Every app also gets:

- `screen.snapshot`: buttons, inputs, text and `testID` views on screen, with positions.
- `screen.fill`, `screen.press`: call an input's or button's own handlers, found by `testID`, label, placeholder or text, and return once React has rendered the result.
- `screen.waitFor`, `screen.findText`: wait for, or check, text or a target on screen.
- `bridge.restore`: undo what the agent changed, by running every `*.restore` tool.
- `bridge.logs`, `bridge.ping`, `bridge.tools`.

Custom tools that change the screen can `await settle()` (from `@avasapp/agent-bridge`) so the next check sees the render.

Errors come back on their own: each reply carries what the app logged with `console.error`, threw or left unhandled since the previous reply, tagged with the call it happened during or after.

## From the agent

```sh
npx agent-bridge session start            # hold one connection; call/tools/run reuse it
npx agent-bridge tools
npx agent-bridge call query.pin '[["features"], {"beta": false}]'
npx agent-bridge call screen.press '"add-plant"'
npx agent-bridge call screen.fill '["plant-name", "Fiddle leaf fig"]'
npx agent-bridge call screen.waitFor '"Name is required"'
npx agent-bridge run flows/add-plant.mjs --strict   # fail if the app logged an error
npx agent-bridge session stop             # runs bridge.restore, then disconnects
```

A session stops itself, restore included, after 15 minutes without calls (`--idle`), and reconnects if the app reloads.

```ts
import { connect } from '@avasapp/agent-bridge/client'

const app = await connect({ metro: 'localhost:8081' })
await app.call('router.navigate', '/add')
await app.call('screen.fill', 'plant-name', 'Fiddle leaf fig')
await app.call('screen.press', 'save-plant')
```

A flow is a module the CLI runs without a model in the loop:

```js
export default async ({ step }) => {
  await step('flag: beta off', 'query.pin', ['features'], { beta: false })
  await step('save empty form', 'screen.press', 'save-plant')
  await step('error shown', 'screen.waitFor', 'Name is required')
  await step('undo', 'bridge.restore')
}
```

No device tool is needed. Pair one (such as agent-device) with the bridge for what it can't reach: system alerts, permission prompts, the keyboard, screenshots, and one real tap per flow.

## Adapters

| Import | Tools | Needs |
| --- | --- | --- |
| `@avasapp/agent-bridge/tanstack-query` | `query.list` `get` `set` `pin` `unpin` `unpinAll` `refetch` `invalidate` `restore` | your `QueryClient` |
| `@avasapp/agent-bridge/zustand` | `store.list` `get` `set` `call` `restore` | your stores |
| `@avasapp/agent-bridge/react-native-mmkv` | `mmkv.list` `keys` `get` `set` `delete` `restore` | your MMKV instances |
| `@avasapp/agent-bridge/expo-router` | `router.navigate` `push` `replace` `back` `current` | `router` and `useNavigationContainerRef()` from expo-router |
| `@avasapp/agent-bridge/network` | `net.log` `mock` `mocks` `unmock` `clear` `restore` | nothing: patches `fetch` and `XMLHttpRequest` in dev |

A pin keeps seeded data in place through refetches until you unpin it. `net.mock('/inbox', { status: 500 })` or `{ offline: true }` fails a route; apps can fake a whole backend with `mockRequests` from the same import.

## Transports

| | Expo dev-tools socket | CDP |
| --- | --- | --- |
| Round trip, local | 0.5 ms | 1.3 ms |
| Emoji in payloads | yes | yes (escaped for you) |
| Works with | Expo CLI | any RN app on Metro |

`connect()` tries Expo first and falls back to CDP.

## Release builds

Every entry point is gated on `process.env.NODE_ENV`, like `react/index.js`: Metro inlines it and a release bundle gets empty stubs. Check a bundle in CI:

```sh
npx agent-bridge assert-absent path/to/main.jsbundle
```

## Traps we hit

- **Run the agent on the machine with the simulator.** Every call pays the network otherwise.
- **Hidden tabs stay mounted.** `screen.findText` skips anything under an inactive `RNSScreen`.
- **Expo checks the debugger's Origin** against the host Metro advertises and drops mismatches silently. The client reads it from the manifest.
- **Expo Go on Android has no CDP `Runtime.evaluate`.** Use the Expo socket there (the default); CDP works in dev builds and in Expo Go on iOS.
- **Expo's socket broadcasts to every app.** Calls are addressed to one device; pick it with `--device` when several are connected.
- **Screen checks through the accessibility tree are slow** (hundreds of ms each). Check in-app, and keep one real UI check per flow.
- **`screen.fill` skips the keyboard.** It runs the input's handlers, so validation and state are real, but autocorrect, native `maxLength` and uncontrolled inputs' native text are not.
- **Keep your `QueryClient` in state** (`useState(() => new QueryClient())`). Created at module level, a Fast Refresh can leave the bridge holding a different client than the screen.

## License

MIT © Avas Enterprises
