---
'@avasapp/agent-bridge': patch
---

CDP: when the app's debugger can't run code (Expo Go on Android has no `Runtime.evaluate`), say so and suggest `--transport expo`, instead of reporting that agent-bridge isn't running.
