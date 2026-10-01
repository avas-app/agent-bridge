# Realtime messages

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

`bridge.restore` unmutes channels and ends a faked connection state.
