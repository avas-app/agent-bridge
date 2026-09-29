---
'@avasapp/agent-bridge': minor
---

New `@avasapp/agent-bridge/react-native-webview` adapter (optional peer dependency `react-native-webview`, empty stub in release builds). `useWebViewTools(ref, { name, allowedOrigins?, redact? })` registers a WebView; `webviewTools()` adds `webview.list`, `snapshot`, `press`, `fill`, `waitFor`, `url`, `reload`, `messages`, `message`, `send`, `receive` and `restore`. The DOM tools work like `screen.*` inside the page (open shadow roots and same-origin iframes included; only the first origin plus `allowedOrigins`, as reported by native load events and `onMessage` URLs, never by the page; `null` origins refused unless allowed), the message tools log and fake the page ↔ app traffic, and page `console.error`, uncaught errors and unhandled rejections go to `bridge.logs`, labelled as page output. `screen.snapshot` shows a registered WebView as `webview "name"`. `webview.press`, `fill` and `send` are not undone by `bridge.restore`.
