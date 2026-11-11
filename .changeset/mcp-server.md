---
"@avasapp/agent-bridge": minor
---

`agent-bridge mcp` runs an MCP server on stdio, for agents that prefer MCP tools to a shell: `claude mcp add agent-bridge -- npx @avasapp/agent-bridge mcp`. Each tool the app exposes becomes an MCP tool (`screen.snapshot` is `screen_snapshot`) that takes `args`, an array of its arguments, and `full`. It uses the project's session, or starts one and runs `bridge.restore` when the server exits (`--keep` skips that). It lists the tools again when the app reloads or a different app connects, returns results over 32 KB as a summary unless `full` is true, sends `screen.capture` images as image content, and reports a failed call or a lost app as an error without stopping. See [the CLI docs](https://github.com/avas-app/agent-bridge/blob/main/docs/cli.md#mcp-server).
