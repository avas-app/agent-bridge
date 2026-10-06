---
'@avasapp/agent-bridge': patch
---

A session no longer switches to another app when it reconnects. It used to re-run discovery and attach to whatever single app was connected, so after the app went away its calls could land in a different app on the same Metro. Reconnects now only accept the app the session started on (same name and platform, and the same debugger target over CDP; its deviceId changes on every reload), skip an app another session owns, and otherwise fail with `<app> is not connected; connected: …` until it comes back. `--device` matching several apps is now an error that lists them instead of picking the first (an exact match still wins). `Using session "<name>"` on stderr now names the app and Metro too. Closes #69.

A call over CDP now ends at its timeout even when the debugger never answers the evaluate, as the old runtime's socket does after a JS reload; a session on CDP used to hang there for good instead of reconnecting.
