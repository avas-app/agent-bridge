---
'@avasapp/agent-bridge': patch
---

`screen.waitFor` takes `{scroll:true}`, like `press` and `fill`: a match that is rendered but off screen (below the fold of a `ScrollView`) is scrolled into view and returned, instead of timing out as an off-screen near miss. Without it, waitFor still matches on-screen elements only, and a timeout with an off-screen near miss now points at `{scroll:true}`. `{gone:true}` with `{scroll:true}` is refused. Closes #68.
