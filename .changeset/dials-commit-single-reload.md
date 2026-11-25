---
'@avasapp/agent-bridge': patch
---

Dials: `dials commit-status done` no longer reloads the app through Metro by default. The app already reloads itself after a hook-count error, and the second reload could quit Expo Go mid-load. `--reload` brings the Metro reload back.
