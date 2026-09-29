---
'@avasapp/agent-bridge': minor
---

`agent-bridge call` has `--out <file>`, which writes the result to a file and prints its size and top-level shape. A result over 32 KB now prints as a JSON summary (`resultTooLarge`, `bytes`, `shape`, `hint`) unless `--full` or `--out` is given; **behaviour change** for scripts that parse big `call` output (add `--full`). Flows and the client API still return full values. Fixes results being cut off through a session: a value containing U+2028 or U+2029 (common in scraped text) was split by the session socket's line reader and arrived as invalid JSON.
