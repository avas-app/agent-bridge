---
'@avasapp/agent-bridge': minor
---

New `@avasapp/agent-bridge/network` subpath: `networkTools()` logs fetch and XMLHttpRequest traffic (`net.log`, `net.clear`) and lets agents mock responses, failures and offline (`net.mock`, `net.unmock`, `net.mocks`, `net.restore`). Apps can register their own mocks, including stateful handlers, with `mock()` and `mockRequests()`; `net.restore` removes only the agent's.
