import type { WebViewLike, WebViewOptions } from '../adapters/webview-host'

type AppProps = Pick<
  WebViewOptions,
  | 'injectedJavaScriptBeforeContentLoaded'
  | 'onLoadStart'
  | 'onLoadEnd'
  | 'onNavigationStateChange'
>

const wrap = <T extends (event: never) => unknown>(onMessage?: T): T | undefined => onMessage

// The app passes its own script and load handlers as options, not props (see
// the README), so hand them back: the WebView behaves as if the adapter
// weren't there. No hooks, so the hook order matches any build.
export function useWebViewTools(
  _ref: { current: WebViewLike | null },
  options: WebViewOptions,
): { props: AppProps; wrap: typeof wrap } {
  const props: AppProps = {}
  const { injectedJavaScriptBeforeContentLoaded, onLoadStart, onLoadEnd, onNavigationStateChange } = options
  if (injectedJavaScriptBeforeContentLoaded !== undefined)
    props.injectedJavaScriptBeforeContentLoaded = injectedJavaScriptBeforeContentLoaded
  if (onLoadStart) props.onLoadStart = onLoadStart
  if (onLoadEnd) props.onLoadEnd = onLoadEnd
  if (onNavigationStateChange) props.onNavigationStateChange = onNavigationStateChange
  return { props, wrap }
}
export const webviewTools = () => ({})
