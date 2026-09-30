# @avasapp/agent-bridge

Let coding agents drive a running React Native app directly. Seed data, flip flags, fake realtime messages, navigate and check the screen in **milliseconds**, without tapping through the app. It works alongside [agent-device](https://github.com/callstack/agent-device): agent-device opens the app and handles native UI, and agent-bridge handles everything inside the app.

![The same checks with agent-device alone (22.4 s) and with agent-bridge (1.4 s): hide a tab, turn on dark mode, fill in a form, seed data, fake a live message and undo it all](example/media/demo.gif)

The same 19 checks on [the example app](example), at real speed: 22.4 s with agent-device alone, 1.4 s with agent-bridge. Most calls take a few milliseconds ([benchmarks](docs/benchmarks.md)).

Works on Expo (dev-tools socket) and on bare React Native (CDP over Metro). Dev builds only: release builds get empty stubs.

## Install

```sh
bun add -d @avasapp/agent-bridge   # or npm / yarn / pnpm
```

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

Mount the hook in a file that only runs in development. You choose every tool; [adapters](docs/adapters.md) for common libraries are one import away.

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

Every app also gets `screen.snapshot`, `screen.press`, `screen.fill`, `screen.scroll`, `screen.waitFor`, `screen.findText`, `app.reload`, and `bridge.restore` to undo everything the agent changed. See [built-in tools and restore](docs/built-in-tools.md), including how to give agents your own hooks and register their undo.

Most flows need the app in a known state first, such as a user signed in locally with every request mocked. Define that once as a [scenario](docs/scenarios.md).

## From the agent

```sh
npx agent-bridge session start            # hold one connection; call/tools/run reuse it
npx agent-bridge tools
npx agent-bridge call scenario.apply '["signedIn", {"user": {"name": "Ada"}}]'
npx agent-bridge call query.pin '[["features"], {"beta": false}]'
npx agent-bridge call screen.press '"add-plant"'
npx agent-bridge call screen.waitFor '"Name is required"'
npx agent-bridge run flows/add-plant.mjs --strict   # fail if the app logged an error
npx agent-bridge session stop             # runs bridge.restore, then disconnects
```

Agents should run `./node_modules/.bin/agent-bridge` (or `bunx agent-bridge`) rather than `npx`, which is slower and can print npm warnings into their output. See [the CLI](docs/cli.md) for flows, batch mode, the REPL, sessions and the `connect()` client.

No device tool is needed. Pair one (such as agent-device) with the bridge for what it can't reach: system alerts, permission prompts, the keyboard, screenshots, and one real tap per flow.

## Docs

- [Built-in tools and restore](docs/built-in-tools.md)
- [The CLI, flows and the client](docs/cli.md)
- [Scenarios](docs/scenarios.md): signed-in state, strict network, fixtures, gates
- [Adapters](docs/adapters.md): TanStack Query, Zustand, MMKV, Expo Router, network
- [WebViews](docs/webviews.md)
- [Realtime](docs/realtime.md): Ably, socket.io, any other library
- [Security and release builds](docs/security.md)
- [Benchmarks](docs/benchmarks.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © Avas Enterprises
