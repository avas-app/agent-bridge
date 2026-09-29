---
"@avasapp/agent-bridge": minor
---

CLI: `agent-bridge call --batch` reads `tool args` lines from stdin and prints one JSON line per call over a single connection (`--stop-on-error`, `--full`, `--out <dir>`; exits 1 if a call failed), and `agent-bridge repl` is an interactive prompt on the same loop with history, tab completion and `.time`/`.tools`/`.pending`/`.restore` dot commands. With stdin not a terminal, `repl` behaves like `--batch`.

In batch and REPL input, arguments that start like JSON (`[`, `{`, `"`) but don't parse are reported as an error instead of being sent as a string; `call` itself is unchanged.
