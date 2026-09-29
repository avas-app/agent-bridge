# @avasapp/agent-bridge

Let coding agents drive a running React Native app directly. Seed data, flip flags, fake realtime messages, navigate and check the screen in **milliseconds**, without tapping through the app. It works alongside [agent-device](https://github.com/callstack/agent-device): agent-device opens the app and handles native UI, and agent-bridge handles everything inside the app.

## Demo

![The same checks with agent-device alone (22.4 s) and with agent-bridge (1.4 s): hide a tab, turn on dark mode, fill in a form, seed data, fake a live message and undo it all](example/media/demo.gif)

The same checks on [the example app](example) in Expo Go, both at real speed, all on one Mac:

- **agent-device alone** ([`demo-agent-device.mjs`](example/flows/demo-agent-device.mjs)) taps and types through the UI, edits the fake backend and reloads to change the flag and the data, and asks the realtime server to push a message.
- **agent-device + agent-bridge** ([`demo.mjs`](example/flows/demo.mjs)) makes each change with one call, then undoes them all with `bridge.restore`.

agent-device 0.21.15 won't press or fill most of this screen by selector on the iOS 27 simulator ([callstack/agent-device#2996](https://github.com/callstack/agent-device/issues/2996)), so the agent-device side looks up each element's frame and taps its centre. That adds one lookup per tap or fill.

| Call | Round trip |
| --- | --- |
| `bridge.ping` | 1–4 ms |
| `screen.findText`, `screen.waitFor` (already there) | 3–9 ms |
| `screen.fill`, `screen.press` | 20–120 ms, render included |
| `query.pin`, `store.call`, `router.navigate` | 11–55 ms, render included |
| 19 steps, no pauses | 1.3–1.5 s wall, 0.9 s of it waiting on the fake backend |

```
19 steps with agent-bridge:       1.4 s wall
same checks, agent-device alone:  22.4 s wall
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
      ...storeTools(
        { settings: useSettingsStore, auth: useAuthStore },
        // Masks these paths in every store.* output; `store.set` and
        // `store.call` never echo the whole store. An action's return value
        // is matched by store path only if it is a piece of the state itself,
        // not a copy; use a hook function for those.
        { redact: { auth: ['accessToken', 'refreshToken', 'user.phone'] } },
      ),
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

- `screen.snapshot`: buttons, inputs, text, and `testID` or labelled views on screen, with positions and `checked` / `selected` / `expanded` state.
- `screen.fill`, `screen.press`: call an input's or button's own handlers, found by `testID`, label, placeholder or text, and return once React has rendered the result. A target is a string or `{testID, label, placeholder, text, at:[x,y], index}`; unknown keys are errors. `{at:[x,y]}` hits the smallest element covering that point (icon-only buttons), and `index` picks among several matches, in the target or as a trailing `{index}` argument. `screen.press(target, {force:true})` presses a disabled element on purpose.
- `screen.waitFor`, `screen.findText`: wait for, or check, text or a target on screen. Both match the same joined text the snapshot shows; `findText` also matches accessibility labels (`{labels:false}` for text only) and lists near misses when nothing matches.
- `bridge.restore`: undo what the agent changed, by running every `*.restore` tool. With the network and TanStack Query adapters it also resets queries whose data came from a `net.mock` (`query.restore` returns `mockedCleared`; `net.unmock` and `net.restore` do it too), in any order. A query counts as mocked when a request its query function made synchronously was answered by an agent mock. If the function awaits before requesting, any mock answering during its fetch marks it, which can reset a query that was actually real. Mocks from app code or scenarios aren't tracked. Infinite queries stay marked until reset, since a real page fetch leaves the mocked pages.
- `app.reload`: reload the app's JS (`DevSettings.reload`). Pending restores are lost; a session waits for the new bridge before the next call.
- `bridge.logs`, `bridge.ping`, `bridge.tools`.

Custom tools that change the screen can `await settle()` (from `@avasapp/agent-bridge`) so the next check sees the render.

Errors come back on their own: each reply carries what the app logged with `console.error`, threw or left unhandled since the previous reply, tagged with the call it happened during or after.

## From the agent

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
```

**Skip npx for agents.** `npx` loads npm's config on every call. If the project's `.npmrc` has keys npm doesn't know, each call prints `npm warn Unknown project config …` into the agent's output, and npx adds process startup. The installed bin does neither: run `./node_modules/.bin/agent-bridge …` (or `bunx agent-bridge …`) in place of `npx agent-bridge` in every command here.

**Timing checks and long sequences.** Every CLI call is a new process. Measured on one Linux box (machine-dependent), that is roughly 90–100 ms with the bin and 280–320 ms through `npx` (about 55 and 250 ms with a session running), all of it startup rather than the bridge. For a timing check, or more than a handful of calls, write a flow file and use `agent-bridge run`: it pays startup once and prints how long each step took.

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

`call` prints a result over 32 KB as a summary (`resultTooLarge`, size, shape, a hint) instead of flooding the terminal: pass `--out <file>` to write it to a file, or `--full` to print it. Flows and `connect()` always get the full value.

A session stops itself, restore included, after 15 minutes without calls (`--idle`), and reconnects if the app reloads. After a reload it warns `app reloaded; N pending restores lost: store, query` (the areas that had something to undo) in the next call's output, failed or not, and in `session stop`, because the old runtime's undo state is gone.

```ts
import { connect } from '@avasapp/agent-bridge/client'

const app = await connect({ metro: 'localhost:8081' })
await app.call('router.navigate', '/add')
await app.call('screen.fill', 'plant-name', 'Fiddle leaf fig')
await app.call('screen.press', 'save-plant')
```

A flow is a module the CLI runs without a model in the loop. `step(label, tool, ...args)` takes the arguments spread, or one array as the whole list, as `call` does:

```js
export const scenario = 'signedIn'   // optional: see Scenarios

export default async ({ step }) => {
  await step('flag: beta off', 'query.pin', ['features'], { beta: false })
  await step('save empty form', 'screen.press', 'save-plant')
  await step('error shown', 'screen.waitFor', 'Name is required')
  await step('undo', 'bridge.restore')
}
```

To run flows from your own script or CI job, import them and pass them to `runFlow`. It applies declared scenarios, restores afterwards, and throws what the flow threw:

```ts
import { connect, runFlow } from '@avasapp/agent-bridge/client'
import * as mainTabs from './flows/main-tabs.flow.mjs'

const app = await connect({ metro: 'localhost:8081' })
const { errors, restoreErrors } = await runFlow(app, mainTabs, { scenarios: [{ name: 'signedIn' }] })
app.close()
if (errors || restoreErrors.length) process.exit(1)
```

No device tool is needed. Pair one (such as agent-device) with the bridge for what it can't reach: system alerts, permission prompts, the keyboard, screenshots, and one real tap per flow.

## Scenarios

Most flows need the app in a known state first, above all a signed-in user. A scenario is a named setup the app defines once, for example a user who is signed in **locally**: a fake token, a fake user, and every request answered in the app, never by the real server.

```ts
import { type Scenarios, useAgentBridge } from '@avasapp/agent-bridge'
import { mockApi, strictNetwork } from '@avasapp/agent-bridge/network'

const scenarios: Scenarios = {
  signedIn: {
    description: 'Signed in locally; no request reaches a server.',
    // JSON Schema: bad options fail before apply runs, and say why.
    options: {
      type: 'object',
      properties: {
        user: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' } } },
      },
    },
    apply: async ({ options, call, onUndo }) => {
      const user = { ...defaultUser, ...options?.user }
      // Guards first, so nothing leaves the app with the fake token.
      onUndo(realtimeGate.close())
      onUndo(strictNetwork({ allow: ['cdn.example.com'] }))
      onUndo(mockApi(API_URL, {
        'GET /me': { json: user },
        'GET /orders/:id': ({ params }) => ({ json: orders[params.id] }),
      }))
      onUndo(await addNativeRewriteRule(tilesHost, localTiles))  // any app code
      await call('store.set', 'auth', { token: 'local', user })  // store.restore undoes it
      return { user }
    },
  },
}

useAgentBridge({ tools, scenarios })
```

- `options` is a JSON Schema (2020-12, checked with [`@cfworker/json-schema`](https://github.com/cfworker/cfworker/tree/main/packages/json-schema), which needs no `eval` and runs on Hermes). `scenario.apply` checks the options before anything changes, and lists every problem at once, such as `options/user/email: String does not match format "email"`. An object schema that lists `properties` rejects other keys (`options: unknown option "usr". Known: user`) unless it sets `additionalProperties`. So a typo fails instead of being ignored. No options are checked as `{}`, so `required` ones are reported.
- `apply` is ordinary app code. `call(tool, ...args)` runs a bridge tool, and that tool's own restorer undoes the change. `onUndo(fn)` covers everything else: app mocks, gates, native state such as a URL-rewrite rule.
- `bridge.restore` runs every scenario's undo callbacks **last**, newest first, after the store, query and network restorers. The guards stay up until the app is back in its real state. If `apply` throws, the callbacks it had registered run straight away.
- Tools: `scenario.list`, `scenario.apply [name, options?]` (applying an active one again undoes it first) and `scenario.restore`. `npx agent-bridge scenarios` lists them.
- A flow declares what it needs with `export const scenario = 'signedIn'`, or `export const scenarios = ['signedIn', { name: 'cart', options: { items: 2 } }]`. `agent-bridge run` applies them before the flow and runs `bridge.restore` afterwards, even when the flow fails. The flow gets what each `apply` returned as `scenarios.signedIn`. A failed restorer makes the run exit non-zero. `run --scenario signedIn` adds one to any flow, with JSON options after `=` (`--scenario 'signedIn={"user":{"name":"Ada"}}'`); it replaces a declared one of the same name.

**Strict network.** `strictNetwork({ allow?, status?, offline? })` from `@avasapp/agent-bridge/network` (or `net.strict` from the agent) fails every `fetch` or `XMLHttpRequest` that no mock answers. The request gets a 501 with `{ error: "agent-bridge strict network: no mock for GET https://…" }` and a `console.error`, so the agent sees it with the reply. With `offline: true` it fails like a network failure instead. `net.strict` lists the requests it blocked. `allow` lets hosts through (substrings or RegExps); Metro always gets through. It covers JS requests only: images, native SDKs (a map's tile fetches, say), and WebSockets go around it, so a scenario handles those with app code and `onUndo`.

**Fixtures.** `mockApi(baseUrl, routes, options?)` answers `'METHOD /path'` routes, or `'/path'` for any method. `:name` matches one path segment and `*` the rest; the query string is ignored. A route's value is a response (`{ json }`, `{ status, body }`…) or a handler that gets the request with `params` and `query`. It returns a function that removes the routes.

**Gates.** Some side effects must wait while a scenario runs, such as a realtime client connecting with the fake token and signing the user out when auth fails. `createGate(name)` from `@avasapp/agent-bridge` is a counted switch: `gate.close()` returns the function that reopens it (hand that to `onUndo`), `gate.closed` is what app code checks, and `gate.subscribe(fn)` hears it change. In a release build it's always open. `realtime.connection` isn't enough on its own: it hides the state from the app, but the client still connects.

The example app's [`src/dev/scenarios.ts`](example/src/dev/scenarios.ts) is a complete local `signedIn`, and [`flows/checks/signed-in.mjs`](example/flows/checks/signed-in.mjs) declares it.

## Adapters

| Import | Tools | Needs |
| --- | --- | --- |
| `@avasapp/agent-bridge/tanstack-query` | `query.list` `get` `set` `pin` `unpin` `unpinAll` `refetch` `invalidate` `restore` | your `QueryClient` |
| `@avasapp/agent-bridge/zustand` | `store.list` `get` `set` `call` `restore` | your stores |
| `@avasapp/agent-bridge/react-native-mmkv` | `mmkv.list` `keys` `get` `set` `delete` `restore` | your MMKV instances |
| `@avasapp/agent-bridge/expo-router` | `router.navigate` `push` `replace` `back` `dismiss` `dismissAll` `current` | `router` and `useNavigationContainerRef()` from expo-router |
| `@avasapp/agent-bridge/network` | `net.log` `entry` `mock` `mockFromLog` `mocks` `unmock` `strict` `clear` `restore` | nothing: patches `fetch` and `XMLHttpRequest` in dev |
| `@avasapp/agent-bridge/ably` | `realtime.channels` `log` `emit` `mute` `unmute` `connection` `restore` | your Ably `Realtime` client |
| `@avasapp/agent-bridge/socket.io` | `realtime.channels` `log` `emit` `mute` `unmute` `connection` `restore` | your socket.io `Socket` |
| `@avasapp/agent-bridge/realtime` | `realtime.channels` `log` `emit` `mute` `unmute` `restore` | two lines in your own subscribe function |

A pin keeps seeded data in place through refetches until you unpin it. `net.mock('/inbox', { status: 500 })` or `{ offline: true }` fails a route (the newest mock is tried first; `{ priority }` reorders mocks from the same source); `net.entry <id>` returns a logged request with whole bodies and `net.mockFromLog <id> [patch]` turns its response into a mock; apps can fake a whole backend with `mockRequests` or `mockApi` from the same import, and turn on strict mode with `strictNetwork`.

**Modals.** `router.back` pops the navigator and knows nothing about modals or sheets your app renders itself, so it can pop the screen under an open one. `router.dismiss` and `router.dismissAll` close route-based modals. For app-rendered modals there is no reliable way to press hardware back from JS (iOS has no back button, and Android's `BackHandler` cannot be fired from outside), so register a tool with your own modal system and let the agent call it:

```ts
// in AgentBridge: tools: { ...routerTools(router, { navigation }), 'modal.close': () => modalStore.getState().closeTop() }
```

## Realtime

The realtime tools let an agent see realtime messages, send the app a fake one, and stop real ones from overwriting a state it set up. They work with any library.

With Ably or socket.io, pass the client where you create it, **before the app subscribes**. Listeners added earlier stay invisible.

```ts
import { ablyTools } from '@avasapp/agent-bridge/ably'
import { socketIoTools } from '@avasapp/agent-bridge/socket.io'

export const ably = new Ably.Realtime(options)
export const realtimeDevTools = ablyTools(ably)     // or socketIoTools(socket)

// in AgentBridge: tools: { ...realtimeDevTools, ... }
```

With any other library, or your own subscribe layer, wrap each listener:

```ts
import { createRealtimeTap } from '@avasapp/agent-bridge/realtime'

export const realtimeTap = createRealtimeTap()   // tools: { ...realtimeTap.tools }

export function subscribe(channel: string, onMessage: (message: Message) => void) {
  const { listener, unsubscribe } = realtimeTap.wrap(channel, onMessage)
  const off = client.subscribe(channel, listener)
  return () => { off(); unsubscribe() }
}
```

```sh
npx agent-bridge call realtime.channels
npx agent-bridge call realtime.mute '"order-42"'                       # the real feed goes quiet
npx agent-bridge call realtime.emit '["order-42", {"name": "status", "data": {"status": "arrived"}}]'
npx agent-bridge call realtime.log '{"channel": "order-42"}'
npx agent-bridge call realtime.connection '"disconnected"'             # null goes back
```

- `realtime.emit` runs the app's own handlers. Ably gets an Ably message shaped like one ably-js decodes (`{ id, name, data, timestamp, action, version, annotations }` plus what you pass, e.g. `clientId`, `connectionId`, `extras`; `name` is the event name, there is no `event` field), socket.io gets the arguments after the event name (`["chat", "a", "b"]` calls `listener("a", "b")`), and `createRealtimeTap` gets the value as is, or what its `toMessage` option builds.
- `realtime.mute` drops real messages; injected ones still get through unless you pass `{ "dropInjected": true }`. `"*"` mutes every channel.
- `realtime.connection` fakes a state through the client's own events (Ably's `connection.on` and `connection.state`, socket.io's `connect` / `disconnect`) and drops real messages until the state is `connected` again. Ably channel states don't follow. `socket.connected` keeps its real value: socket.io reads it itself, and faking it would hold real traffic back until the next reconnect.
- `realtime.log` keeps the last 50 messages, and logs a message once however many listeners get it.
- `createRealtimeTap` takes `describe` (what to log), `toMessage` (what `emit` delivers), `channelInfo` (extras for `realtime.channels`), `connection` (to add `realtime.connection`) and `namespace` (for a second tap).
- socket.io `onAny` listeners don't get injected events.

### Writing an adapter

To patch a client instead of wrapping each listener, name its add and remove methods and say which channel a call is for. `tapListeners` handles the bookkeeping and every remove form (all, by event, by listener). `realtimeAdapter` patches each client once. A Pusher-style `channel.bind(event, fn)` is this much:

```ts
import { createRealtimeTap, realtimeAdapter, tapListeners } from '@avasapp/agent-bridge/realtime'

export const pusherTools = realtimeAdapter((channel: Channel, options: {}) => {
  const tap = createRealtimeTap()
  tapListeners(tap, channel, {
    add: 'bind',
    remove: 'unbind',
    channel: ([event]) => `${channel.name}:${event}`,   // undefined leaves a call alone
  })
  return tap
})
```

Pass `accepts` when a listener filters by event, and `message: 'args'` when the message is every argument (as in socket.io). `fakeableConnection(client, { property, events, states, announce })` adds `realtime.connection`: it fakes the state property and silences the client's own change events while a fake is on. Pass `fakeProperty: false` if the client reads that property itself to decide whether to deliver or send. [`src/adapters/`](src/adapters) has the Ably and socket.io adapters built this way.

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

## What runs where

- **On your machine:** `agent-bridge run` and `runFlow` run the flow module you point them at, with your permissions, the same as `node flow.mjs`. Only run flows you'd run as scripts. In CI, don't run flows from untrusted forks with secrets in the environment, as with any test.
- **In the app:** the bridge only calls tools and scenarios the app registered. Arguments and scenario options arrive as JSON data. Over CDP the client evaluates one fixed call with the message as a JSON string; the Expo transport sends plain JSON. Nothing the agent sends is evaluated as code.
- **Who can reach it:** anyone who can reach Metro's debugger can already run any code in a dev build. The bridge adds no new way in, and release builds carry none of it (`assert-absent` checks).

## License

MIT © Avas Enterprises
