---
"@avasapp/agent-bridge": minor
---

CLI: `agent-bridge call <tool> @args.json` reads the arguments from a file (`@-` for stdin), so a value over the shell's ~128 KB argument limit no longer fails with `Argument list too long`. A file follows the inline rules: an array is the argument list, any other value is one argument. With several words, each is one argument and `@feed.json` is that file's JSON (`call net.mock '"/feed"' @feed.json`). `call --batch` lines accept `@file` as their argument list. A missing file or invalid JSON fails with an error naming the path.

Behaviour changes: a bare argument starting with `@` is now a file path, not a string (pass such a string as JSON: `'"@user"'`), and `call` with several argument words now sends each as an argument instead of ignoring all but the first.
