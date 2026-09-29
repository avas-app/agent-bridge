---
'@avasapp/agent-bridge': patch
---

Realtime: an Ably message from `realtime.emit` now carries the fields ably-js sets on a real one (`action`, `serial`, `version`, `annotations`, besides `id` and `timestamp`; `version` follows `serial` and `timestamp` as in ably-js), and passing `event` instead of `name` is an error rather than an empty event name. The tool description says what to pass per adapter: Ably `{ name, data }`, socket.io the event name as the channel and the arguments after it (new `emitUsage` option on `createRealtimeTap` for other libraries).
