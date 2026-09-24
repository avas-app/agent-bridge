---
'@avasapp/agent-bridge': minor
---

- New built-in tools: `screen.snapshot` lists the buttons, inputs, text and testID views on screen; `screen.press` and `screen.fill` call a control's handlers by testID, label, placeholder or text; `screen.waitFor` waits for a target to appear or go.
- `press` and `fill` return once React has committed what they caused. Custom tools can do the same with the new `settle()` export.
