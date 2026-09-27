# Example: Sprout

A small Expo app wired to agent-bridge, with a flow that drives it.

```sh
(cd .. && bun install && bun run build)   # the app uses this repo's build
npm install
npm run realtime                          # optional: the live inbox's socket.io server
npx expo start                            # open it in Expo Go
npx agent-bridge run flows/demo.mjs       # PACE=paced holds each step
```

`src/dev/` holds the bridge setup and the step overlay (dev builds only). `media/` has the recordings.

The inbox is live: `src/realtime.ts` connects a socket.io socket to `realtime-server.mjs` (port 8138, on the Metro machine) and patches it with `socketIoTools`, so agents get `realtime.*`. Push a real message with `curl 'localhost:8138/push?title=Hello'`. `flows/checks/realtime.mjs` checks the whole thing: real pushes, mute, emit, a faked disconnect and restore. Without the server the app still runs, and `realtime.emit` still works.
