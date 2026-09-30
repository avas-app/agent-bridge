# WebViews

A page in a `react-native-webview` runs in its own JavaScript context, so `screen.*` sees one opaque element. Register the WebView and agents get the same verbs inside it, plus its `postMessage` traffic. Add `react-native-webview` (13 or later) as usual; the adapter needs nothing else and works on iOS and Android.

```tsx
import { useWebViewTools, webviewTools } from '@avasapp/agent-bridge/react-native-webview'

function Checkout() {
  const ref = useRef<WebView>(null)
  const webview = useWebViewTools(ref, {
    name: 'checkout',
    allowedOrigins: ['https://pay.example.com'],   // optional
    redact: ['token', 'user.phone'],               // optional, see below
  })
  return (
    <WebView
      ref={ref}
      source={{ uri: 'https://shop.example.com/cart' }}
      {...webview.props}
      onMessage={webview.wrap(onMessage)}
    />
  )
}

// in AgentBridge: tools: { ...webviewTools(), ... }
```

`webview.props` holds `injectedJavaScriptBeforeContentLoaded` (the adapter's page script), `injectedJavaScriptBeforeContentLoadedForMainFrameOnly: true` and `onLoadStart`, `onLoadEnd` and `onNavigationStateChange`, which tell the adapter from native code which page it is talking to. Spread them **before** any prop of your own, and pass your own versions of those four as `useWebViewTools` options (`injectedJavaScriptBeforeContentLoaded` runs after the adapter's; the handlers are called after it): a prop set after the spread replaces the adapter's (setting `injectedJavaScriptBeforeContentLoadedForMainFrameOnly` to `false` after it puts the script into every iframe: don't), and calls then fail with `page script did not check in`. `wrap(onMessage)` gives the WebView its `onMessage`; the adapter's own messages never reach your handler. Each WebView needs its own `name`: a second live one with the same name is refused with a `console.error`. In a release build the hook's `props` hold only your own `injectedJavaScriptBeforeContentLoaded`, `onLoadStart`, `onLoadEnd` and `onNavigationStateChange` from the options (the ones you set), so the WebView behaves as if the adapter weren't there, and `wrap` returns your handler unchanged.

`screen.snapshot` shows the WebView where it sits, as `webview "checkout"`, so an agent knows to switch to `webview.*`.

- `webview.list`, `webview.url`, `webview.reload`: registered WebViews (name, url, loaded, whether the current origin is allowed), the URL a WebView is on, and a reload that waits for the page to load again.
- `webview.snapshot [name]`, `webview.press`, `webview.fill`, `webview.waitFor`: buttons, links, inputs, text and testID / `aria-label` elements, in the shape of `screen.snapshot`. Targets match in `screen.*` order: `data-testid` (also `data-test-id`, `data-cy`), `aria-label`, placeholder, visible text, then role; `{testID, label, placeholder, text, role, index}` works too. `press`, `fill` and `waitFor` take `{webview: name}` last when several are registered, and return after the page settles: the next animation frame, then 100 ms with no DOM mutations (iframes and shadow roots included), at most 2 s. `fill` uses the native value setter and dispatches `input` and `change`, so React and Vue inputs pick it up; password values are never echoed (`filled` is `[redacted]`). A `<select>` shows its `options` (value, label, selected) instead of listing each `<option>` as text, and `fill` picks by value, then by visible label; anything else is refused with the list of options. A `press` or `fill` that navigates returns `{navigated: true, url}`; a `waitFor` or `snapshot` in flight when the page navigates fails with `The page navigated to …` and is called again on the new page. Calls made while a new page loads wait (up to 10 s; `firstLoadTimeoutMs` in the hook options changes it) for its script to check in.
- `webview.messages [name]`, `webview.message <id>`: the last 100 messages in both directions with timestamps: page → app (`onMessage`), and app → page (`postMessage`, `injectJavaScript`, `webview.send`). Bodies are cut at 2 KB (`truncated`, `size`); `webview.message` returns one whole. `redact` masks dotted paths in JSON bodies, or takes a hook `(webview, path, value) => value` like `storeTools`; text that isn't JSON (a script passed to `injectJavaScript`) is only reachable by the hook. Redaction is by key, not by value: a secret that appears inside a string value (a page echoing a token in a message, say) is logged as is. Use the hook form to scrub values, e.g. `(webview, path, value) => typeof value === 'string' ? value.replaceAll(TOKEN, '[redacted]') : value`.
- `webview.send [name] <json>`: delivers a message to the page as if the app had sent it. `webview.receive [name] <json>`: runs your `onMessage` with a fake page message and waits for the render.
- Page `console.error`, uncaught errors and unhandled rejections go to `bridge.logs` and the `! error during <tool>` stream, labelled `[webview checkout, page output]`, cut at 500 characters and on one line, since a page wrote them. `console.warn` is left out.

**What can be read.** Only the origin the WebView first loaded, plus `allowedOrigins`, can be read or driven, and the adapter learns the origin from **native code** (`onLoadStart`, `onNavigationStateChange`, and the `url` of every `onMessage`), never from what a page says. Messages from the page script (checking in, replies, logs) are used only when the native URL is an allowed origin; from any other page they are dropped, and calls, `webview.send` and `webview.receive` are refused before anything is sent. When the page navigates elsewhere, `webview.list` shows `allowed: false`. Origins are compared as browsers write them (`https://x:443` is `https://x`, credentials in a URL don't count). A page with no origin of its own (`source={{ html }}`, `about:blank`, `data:`) has the opaque origin `null`, which is **never** allowed unless you list `'null'` in `allowedOrigins`. Open shadow roots are pierced. Same-origin iframes are read; a cross-origin one shows as `iframe (cross-origin, not reachable)`. Closed shadow roots and the `react-native-web` iframe are not supported. **Sub-frames.** react-native-webview reports the top-level URL, and on Android `window.ReactNativeWebView` is reachable from cross-origin iframes, so the origin alone can't tell an iframe's message from the page's. Every message from the adapter's script (check-in, reply, page log) therefore carries a random per-mount token, which lives in a closure of the script that runs only in the main frame (`injectedJavaScriptBeforeContentLoadedForMainFrameOnly`, forced to `true`; `injectJavaScript` also runs in the main frame only). A message without the token is dropped and never reaches `onMessage`. The script is not given to pages that aren't allowed a second time: after the WebView loads a page outside the allowed origins the token is replaced, so anything such a page learned is worthless (the hook renders the new props). The token is not defence against script running in the allowed page itself, which can read what the adapter reads by design.

**Security.** Every call injects one fixed script with its arguments as a JSON string, so nothing an agent sends is evaluated as page code, and there is no `webview.eval`. Results return over `postMessage` with a per-call nonce, and the adapter swallows its own messages before `onMessage` sees them.

**Restore.** `webview.restore` (part of `bridge.restore`) clears the message logs and drops calls still waiting for a reply. The hooks on the WebView's `postMessage` and `injectJavaScript` stay until it unmounts, so the log keeps filling. It does **not** undo `webview.press`, `webview.fill` or `webview.send`: they change the page and whatever your app did in response. Reload the page to reset it. To fake what the page asks the host for (pickers, biometric prompts, permission dialogs), swap your own handler table in a tool and register `onRestore`, as in [Expose the hooks your agents keep needing](built-in-tools.md#expose-the-hooks-your-agents-keep-needing).
