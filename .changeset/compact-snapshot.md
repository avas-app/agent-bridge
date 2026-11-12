---
'@avasapp/agent-bridge': minor
---

`screen.snapshot` takes `{format: "text"}` for one line per element (`button #save "Save plant" disabled`, with `index=N` on lines that repeat and `@x,y` on lines with no testID, text, label or placeholder) instead of JSON with a rect per element: about a fifth of the size. It also takes `{kinds: ["button", "input"]}` to keep only those kinds and `{within: target}` to keep only elements under a target in the tree. An empty filtered result says what matched nothing, a long label is never cut, and `--out` with `{"format":"text"}` writes the text (`--json` with it is an error).

Behaviour change: `agent-bridge call screen.snapshot` and the MCP `screen_snapshot` tool now print the text form by default. For the old JSON pass `--json` (or `--out`) to `call`, or `{"format": "json"}` as the argument (`args: [{"format": "json"}]` over MCP). `connect()`, `bridge.call` and flows still get JSON unless they ask for text.
