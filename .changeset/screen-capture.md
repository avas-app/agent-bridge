---
'@avasapp/agent-bridge': minor
---

New `screen.capture` tool takes a PNG screenshot and returns `{path}` (or `{base64}` with `{base64:true}` when small) using `react-native-view-shot`, only if the app already has it; the bridge does not depend on it. Without it the tool errors and points to agent-device, `xcrun simctl io` or `adb exec-out screencap -p`. Closes #11.
