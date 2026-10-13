---
"@avasapp/agent-bridge": patch
---

`queryTools` takes any TanStack Query client structurally (`QueryClientLike`), so `queryTools(useQueryClient())` typechecks in an app without a tsconfig `paths` entry for `@tanstack/query-core`.
