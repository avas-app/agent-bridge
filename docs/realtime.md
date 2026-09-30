# Realtime

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

## Writing an adapter

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

Pass `accepts` when a listener filters by event, and `message: 'args'` when the message is every argument (as in socket.io). `fakeableConnection(client, { property, events, states, announce })` adds `realtime.connection`: it fakes the state property and silences the client's own change events while a fake is on. Pass `fakeProperty: false` if the client reads that property itself to decide whether to deliver or send. [`src/adapters/`](../src/adapters) has the Ably and socket.io adapters built this way.
