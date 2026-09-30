---
'@avasapp/agent-bridge': patch
---

Fixes release builds of apps using `useWebViewTools` from `@avasapp/agent-bridge/react-native-webview` losing their own `injectedJavaScriptBeforeContentLoaded`, `onLoadStart`, `onLoadEnd` and `onNavigationStateChange`. The README says to pass these as hook options rather than WebView props, but the release stub ignored its options and returned empty `props`, so an app that did so shipped with no injected script and no load or navigation handlers, silently. The release hook now returns those four from the options in `props` (leaving out any not set, and without `injectedJavaScriptBeforeContentLoadedForMainFrameOnly`), so the WebView behaves as if the adapter weren't there; `wrap` still returns the handler unchanged. Closes #63.
