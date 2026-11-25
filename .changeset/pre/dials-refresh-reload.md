---
'@avasapp/agent-bridge': patch
---

Dials: adding or removing `dial.*` calls no longer crashes the app under Fast Refresh. React Refresh can't see the hooks inside `dial.*`, so the screen died with "Rendered fewer/more hooks"; the app now reloads itself when that error appears.
