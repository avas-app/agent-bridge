---
"@avasapp/agent-bridge": minor
---

`agent-bridge init` sets up an app in one command: `npx @avasapp/agent-bridge init`. It installs the package with the app's package manager, writes a dev-only `src/dev/agent-bridge.tsx` wired for what it finds (Expo, expo-router, TanStack Query, WebViews; zustand and MMKV as comments, since they often hold tokens; a TODO for Ably or socket.io), scaffolds `flows/smoke.flow.mjs`, adds the agent skill, and prints the two lines to mount it. It asks once whether to wire `networkTools()`, and never prompts with `--json`, `--yes` or without a terminal, listing the open choice in the report instead. `--dry-run` changes nothing, and a second run skips existing files (`--force` rewrites them). See [the CLI docs](https://github.com/avas-app/agent-bridge/blob/main/docs/cli.md#init).

Flows now go in `<app>/flows/<name>.flow.mjs`, and the example app's flows were renamed to match. `run`'s help no longer lists `.ts` flows, which were never tested.
