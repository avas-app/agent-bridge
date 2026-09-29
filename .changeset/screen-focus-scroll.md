---
'@avasapp/agent-bridge': minor
---

`screen.snapshot`, `screen.findText`, `screen.press`, `screen.fill` and `screen.waitFor` now see only the focused screen: unfocused tabs and native-stack screens, content under an open modal, `display: none` and accessibility-hidden subtrees are skipped, and the result says how many elements (`hidden`) were left out. `screen.snapshot {all:true}` still lists everything and marks hidden ones. New `screen.scroll` (to a target, `{toEnd}`, `{toStart}`, `{by}`, optionally `{within}`) and `screen.refresh` (calls the RefreshControl's `onRefresh`), and `{scroll:true}` on `screen.press` / `screen.fill`. Behaviour change: elements on screens beneath the top one no longer match targets, so a press that only worked by picking a hidden duplicate now needs `{all:true}` to see it.
