---
'@avasapp/agent-bridge': minor
---

`screen.findText` and `screen.waitFor` match the same joined text `screen.snapshot` shows (nested `Text` is one string), and `screen.findText` also matches accessibility labels (`{labels:false}` for text only). A miss lists near misses, including elements that are off screen. `screen.snapshot` shows `checked`, `selected` and `expanded` (from `accessibilityState` / `aria-*`, and a `Switch`'s value) and lists views named only by an accessibility label.

Behaviour changes for existing callers: `screen.findText` now matches the snapshot's text, which collapses whitespace, drops icon glyphs and joins a button's several `Text` parts with spaces, so `exact:true` compares against that one string. Text on an inactive tab or screen is now not found at all (before: found, with `onScreen: 0`). Matches also carry a `field`, and `findText` results for a miss may carry `nearMisses`.
