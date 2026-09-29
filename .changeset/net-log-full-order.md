---
'@avasapp/agent-bridge': minor
---

Network log and mocks: log entries carry `startedAt` (epoch ms) and `net.log` takes `{ since }`. `net.entry <id>` and `net.log { full: true }` return whole bodies instead of ~2 KB, and `net.mockFromLog <id> [patch]` turns a logged response into a mock, deep-merging a patch. `net.mock` documents that the newest mock wins, takes `options.priority` (higher first, negative for a fallback) and reports `shadows` when it will be tried before an agent mock it also matches.
