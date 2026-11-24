---
'@avasapp/agent-bridge': patch
---

Dials: `dials commit-status done` reloads the app through Metro, since removing dial calls changes a component's hook count and Fast Refresh then fails with "Rendered fewer hooks". `--no-reload` skips it.
