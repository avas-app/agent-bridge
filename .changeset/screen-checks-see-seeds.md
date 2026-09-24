---
'@avasapp/agent-bridge': patch
---

- `screen.findText` works on React Native 0.8x: it measures through Fabric's UIManager instead of host instances React now creates only for refs. It also measures DOM elements (react-dom, react-native-web) and no longer imports React Native internals, which broke web bundles.
- `query.set`, `query.pin` and `query.refetch` return after the screen has the data, so a check right after them sees it.
- Pins survive tools being rebuilt on every render, so `query.unpinAll` still finds them.
