# Security and release builds

## What runs where

- **On your machine:** `agent-bridge run` and `runFlow` run the flow module you point them at, with your permissions, the same as `node flow.mjs`. Only run flows you'd run as scripts. In CI, don't run flows from untrusted forks with secrets in the environment, as with any test.
- **In the app:** the bridge only calls tools and scenarios the app registered. Arguments and scenario options arrive as JSON data. Over CDP the client evaluates one fixed call with the message as a JSON string; the Expo transport sends plain JSON. Nothing the agent sends is evaluated as code.
- **Who can reach it:** anyone who can reach Metro's debugger can already run any code in a dev build. The bridge adds no new way in, and release builds carry none of it (`assert-absent` checks).

## Release builds

Every entry point is gated on `process.env.NODE_ENV`, like `react/index.js`: Metro inlines it and a release bundle gets empty stubs. Check a bundle in CI:

```sh
npx agent-bridge assert-absent path/to/main.jsbundle
```
