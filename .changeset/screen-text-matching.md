---
'@avasapp/agent-bridge': minor
---

`screen.findText` and `screen.waitFor` match the same joined text `screen.snapshot` shows (nested `Text` is one string), and `screen.findText` also matches accessibility labels (`{labels:false}` for text only). A miss lists near misses, including elements that are off screen. `screen.snapshot` shows `checked`, `selected` and `expanded` (from `accessibilityState` / `aria-*`, and a `Switch`'s value) and lists views named only by an accessibility label.
