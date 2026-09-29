// How a registered WebView shows up in screen.snapshot: the react-native-webview
// adapter puts this comment at the head of the WebView's
// `injectedJavaScriptBeforeContentLoaded`, a prop that survives every wrapper
// down to the native host, and element extraction reads the name back.
const MARK = /^\/\*agent-bridge:webview:([^*]*)\*\//

const escape = (name: string) => encodeURIComponent(name).replace(/\*/g, '%2A')

export const webViewMark = (name: string): string =>
  `/*agent-bridge:webview:${escape(name)}*/`

/** The registered name in a WebView's props, if it is one. */
export function webViewNameOf(props: Record<string, unknown>): string | undefined {
  const script = props.injectedJavaScriptBeforeContentLoaded
  const found = typeof script === 'string' ? MARK.exec(script) : null
  if (!found) return undefined
  try {
    return decodeURIComponent(found[1] as string)
  } catch {
    return found[1]
  }
}
