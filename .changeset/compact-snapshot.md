---
'@avasapp/agent-bridge': minor
---

`screen.snapshot` takes `{format: "text"}` for one line per element (`button #save "Save plant" disabled`, with `@x,y` only on lines that would otherwise repeat) instead of JSON with a rect per element: about a fifth of the size. It also takes `{kinds: ["button", "input"]}` to keep only those kinds and `{within: target}` to keep only elements inside a target.

Behaviour change: `agent-bridge call screen.snapshot` and the MCP `screen_snapshot` tool now print the text form by default. For the old JSON pass `--json` (or `--out`) to `call`, or `{"format": "json"}` as the argument (`args: [{"format": "json"}]` over MCP). `connect()`, `bridge.call` and flows still get JSON unless they ask for text.
