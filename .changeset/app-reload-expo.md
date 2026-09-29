---
'@avasapp/agent-bridge': patch
---

`app.reload` now reloads through Expo's own `reloadAppAsync` (`globalThis.expo`, Expo SDK 51+) and falls back to `DevSettings.reload()` in apps without Expo. In Expo Go, `DevSettings.reload()` left the reloaded bundle without Expo's native modules ("Cannot find native module 'ExpoAsset'", "main has not been registered") until the app was relaunched. Closes #52.
