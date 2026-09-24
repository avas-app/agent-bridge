# Example: Sprout

A small Expo app wired to agent-bridge, with a flow that drives it.

```sh
(cd .. && bun install && bun run build)   # the app uses this repo's build
npm install
npx expo start                            # open it in Expo Go
npx agent-bridge run flows/demo.mjs       # PACE=paced holds each step
```

`src/dev/` holds the bridge setup and the step overlay (dev builds only). `media/` has the recordings.
