---
"@avasapp/agent-bridge": minor
---

`screen.press` no longer treats a screen-wide pressable (such as tap-to-dismiss-keyboard around a form) as one big button holding all the text under it, and says `via: "ancestor"` when the handler it called belongs to an ancestor. `screen.fill` now works on uncontrolled inputs, fires `onEndEditing`, clears with `""`, and takes `{type:true}` to type one character at a time. `router.navigate`, `push` and `replace` return the route the app ended on once the screen has rendered, throw on `+not-found`, and warn when the route is not the href.
