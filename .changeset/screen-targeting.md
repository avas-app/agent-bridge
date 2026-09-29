---
'@avasapp/agent-bridge': minor
---

`screen.press` and `screen.fill` reject unknown target keys instead of matching everything. New `{at:[x,y]}` target presses icon-only buttons by point. `{index}` now also works as a trailing options argument, and the ambiguity error shows a concrete example. `screen.press(target, {force:true})` presses a disabled element on purpose.
