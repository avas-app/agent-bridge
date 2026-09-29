---
'@avasapp/agent-bridge': patch
---

`net.unmock`, `net.restore` and `query.restore` (so `bridge.restore` and `session stop`) now reset queries whose data came from an agent mock, instead of leaving fake data in the cache where a failing real refetch would keep it. A query counts as mocked when its fetch succeeded while an agent mock answered a request. `query.restore` now returns `{ unpinned, refetched, mockedCleared }`.

Attribution is per request: a query is marked when a request its query function started synchronously was answered by an agent mock. A request started after an await, behind an async interceptor or in a retry is unattributable, so every query fetching then is marked and reset on restore even if real (an observed one refetches once). Infinite queries stay marked until reset; app and scenario mocks aren't tracked.
