---
'@avasapp/agent-bridge': patch
---

A session's reconnect after an app reload can no longer hang forever. Opening a connection (Metro discovery, the websocket upgrade, the CDP handshake, Expo's hello) is now time-bounded, per transport (Expo's socket, then CDP): 12 s per reconnect attempt in a session daemon, 15 s for `connect()` and one-off CLI calls. A stuck reconnect no longer blocks `call`, `session stop` or SIGTERM: calls fail with `The app is gone (...)` or `app not connected; reconnecting`, the daemon retries on its 5 s health check and on the next call until the idle timeout (every 300 ms inside the reload window), and stopping gives `bridge.restore` one bounded reconnect attempt before cutting the attempt in flight. Behaviour change: `openConnection` and `connect()` reject with `Timed out after N ms opening a connection to Metro` where they used to hang. Closes #59.
