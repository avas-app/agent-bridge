---
"@avasapp/agent-bridge": minor
---

Two new adapters. `@avasapp/agent-bridge/async-storage` (`asyncStorageTools(AsyncStorage)`) gives `asyncStorage.list` (with `{limit, prefix}` and values cut to 200 characters), `get`, `set`, `delete` and `restore`. `@avasapp/agent-bridge/secure-store` (`secureStoreTools(SecureStore, knownKeys)`) gives `secureStore.list` (the keys you pass, with set and length), `get`, `set`, `delete` and `restore`; `get` returns `[redacted, N chars]` unless called with `{full:true}`, and `bridge.pending` never shows its keys or values. Both restore what the agent changed, awaiting each async write, and `bridge.restore` and `bridge.pending` include them. `agent-bridge init` adds both, commented out, when it finds the packages.
