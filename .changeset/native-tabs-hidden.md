---
"@avasapp/agent-bridge": patch
---

`screen.snapshot`, `screen.waitFor {gone}`, `screen.findText` and `screen.press` treat unfocused native tabs (react-native-screens `Tabs.Host`, as used by expo-router `NativeTabs`, on iOS and Android) as hidden, like screens under a stack. If the host's selected tab matches no mounted tab screen (or several), nothing is hidden. Where nothing can be measured (React Native's old architecture, or a test renderer), the screen tools that need positions (`snapshot`, `press`, `fill`, `scroll`, `waitFor`) fail with a message saying so instead of returning an empty screen; `snapshot {all: true}` and `findText` still return text and test IDs, with no rects.

A command run from a monorepo root finds the one session started in an app folder under it. Lookup goes downward only: a session started at the root is not found from an app folder, and a session in a nested checkout (a folder with its own `.git`) or in a package of its own is never matched from above. With several app sessions under the root, the command connects directly as before; pass `--session` to pick one. "No single session matches" now says what it looked for, including when `--metro`, `--device` or `--transport` was given.
