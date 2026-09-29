---
'@avasapp/agent-bridge': patch
---

Realtime: an Ably message from `realtime.emit` now carries the fields ably-js sets on a real one (`action`, `version`, `annotations`, besides `id` and `timestamp`), and passing `event` instead of `name` is an error rather than an empty event name. The tool description says what to pass per adapter: Ably `{ name, data }`, socket.io the event name as the channel and the arguments after it.
