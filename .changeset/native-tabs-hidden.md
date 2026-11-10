---
"@avasapp/agent-bridge": patch
---

`screen.snapshot`, `screen.waitFor {gone}`, `screen.findText` and `screen.press` treat unfocused native tabs (react-native-screens `Tabs.Host`, as used by expo-router `NativeTabs`, on iOS and Android) as hidden, like screens under a stack. On the old React Native architecture the screen tools now fail with a message saying so, instead of returning an empty screen. A command run from a monorepo root finds the one session started in an app folder under it, and "No single session matches" now says where it looked.
