---
'@avasapp/agent-bridge': patch
---

A session's reconnect after an app reload can no longer hang forever. Opening a connection (Metro discovery, the websocket upgrade, the CDP handshake, Expo's hello) is now time-bounded, 5 s per reconnect attempt in a session daemon (15 s for `connect()` and one-off CLI calls). A stuck reconnect no longer blocks `call`, `session stop` or SIGTERM: calls fail with `The app is gone (...)` or `app not connected; reconnecting`, the daemon keeps retrying with backoff until the idle timeout, and stopping aborts the attempt in flight. Behaviour change: `openConnection` and `connect()` reject with `Timed out after N ms opening a connection to Metro` where they used to hang. Closes #59.
