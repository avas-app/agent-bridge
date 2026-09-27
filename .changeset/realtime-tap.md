---
'@avasapp/agent-bridge': minor
---

Realtime tools: see, fake and drop realtime messages, and fake connection states (`realtime.channels`, `log`, `emit`, `mute`, `unmute`, `connection`, `restore`). Adapters patch an Ably client (`@avasapp/agent-bridge/ably`) or a socket.io socket (`@avasapp/agent-bridge/socket.io`); any other library can wrap its listeners with `createRealtimeTap` from `@avasapp/agent-bridge/realtime`. `tapListeners`, `fakeableConnection` and `realtimeAdapter` from the same import turn a new adapter into a few lines.
