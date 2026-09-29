---
'@avasapp/agent-bridge': patch
---

`net.unmock`, `net.restore` and `query.restore` (so `bridge.restore` and `session stop`) now reset queries whose data came from an agent mock, instead of leaving fake data in the cache where a failing real refetch would keep it. A query counts as mocked when its fetch succeeded while an agent mock answered a request. `query.restore` now returns `{ unpinned, refetched, mockedCleared }`.
