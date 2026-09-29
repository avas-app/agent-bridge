import { useEffect, useMemo } from 'react'

import { settle } from '../runtime/screen/settle'
import type { Tools } from '../runtime/types'
import {
  BODY_CHARS,
  callPage,
  type Entry,
  entries,
  entryNamed,
  isCurrentAllowed,
  allowedOrigins,
  messageById,
  record,
  register,
  requireAllowed,
  restoreAll,
  sendToPage,
  shown,
  webViewProps,
  type WebViewLike,
  type WebViewOptions,
  type WebViewRedact,
} from './webview-host'

export type { WebViewLike, WebViewOptions, WebViewRedact }

/**
 * Registers a react-native-webview so agents can read and drive it. Spread
 * `props` on the WebView and give it `wrap(onMessage)` as its `onMessage`:
 *
 * ```tsx
 * const ref = useRef<WebView>(null)
 * const webview = useWebViewTools(ref, { name: 'checkout' })
 * <WebView ref={ref} {...webview.props} onMessage={webview.wrap(onMessage)} />
 * ```
 *
 * The bridge's own replies never reach `onMessage`. Add `webviewTools()` to the
 * bridge's tools.
 */
export function useWebViewTools(
  ref: { current: WebViewLike | null },
  options: WebViewOptions,
) {
  const host = useMemo(() => register(ref, options), [ref, options.name])
  host.entry.options = options
  useEffect(() => {
    host.mount()
    return host.dispose
  }, [host])
  // Runs after every render: the ref may hold a new instance by now.
  useEffect(() => host.mount())
  const props = useMemo(
    () => webViewProps(options),
    [options.name, options.injectedJavaScriptBeforeDocumentLoaded],
  )
  return { props, wrap: host.wrap }
}

type Options = { webview?: string; index?: number }

// `[name] <data>`: with one argument it is the data.
function nameAndData(args: unknown[], tool: string): [Entry, unknown] {
  if (args.length === 0 || args.length > 2)
    throw new Error(`${tool} takes [name] <json>`)
  return args.length === 2 ? [entryNamed(String(args[0])), args[1]] : [entryNamed(), args[0]]
}

const bodyOf = (data: unknown): string =>
  typeof data === 'string' ? data : JSON.stringify(data)

const TARGET_HELP =
  'target is a string (testID, label, placeholder, text, then role) or an object that must match every key it sets: {testID, label, placeholder, text, role, index}. testID is data-testid, data-test-id or data-cy. Several matches: add an index, in the target or as {index:n}.'

const WHICH =
  'Give {webview: name} as the last argument when more than one WebView is registered.'

/** Read and drive the WebViews registered with `useWebViewTools`. */
export function webviewTools(): Tools {
  return {
    'webview.list': {
      maxArgs: 0,
      description:
        'The registered WebViews: name, current url, whether the page has loaded, whether its origin is allowed (a page outside the allowed origins is never read or driven), and the allowed origins.',
      run: () =>
        entries().map((entry) => ({
          name: entry.options.name,
          mounted: !!entry.ref.current,
          url: entry.url ?? null,
          loaded: entry.loaded,
          allowed: isCurrentAllowed(entry) ?? null,
          origins: allowedOrigins(entry),
        })),
    },
    'webview.snapshot': {
      maxArgs: 1,
      description:
        'Buttons, links, inputs, text and testID/aria-label elements in a WebView page, in the same shape as screen.snapshot (kind, text, testID, label, placeholder, value, role, checked, disabled, rect). Pierces open shadow roots and same-origin iframes; a cross-origin iframe shows as "iframe (cross-origin, not reachable)". Arguments: [name].',
      run: (name?: string) => callPage(entryNamed(name), 'snapshot', {}),
    },
    'webview.press': {
      maxArgs: 2,
      description: `Click a button, link or control in a WebView page, then wait for the page to settle (next frame, then 100 ms without DOM changes, at most 2 s). Not undone by webview.restore. ${TARGET_HELP} Disabled elements are refused; {force:true} presses anyway. ${WHICH}`,
      run: (target: unknown, options: Options & { force?: boolean } = {}) =>
        callPage(entryNamed(options.webview), 'press', {
          target,
          options: { force: options.force, index: options.index },
        }),
    },
    'webview.fill': {
      maxArgs: 3,
      description: `Set an input's value in a WebView page through the native value setter and dispatch input and change events, so React and Vue inputs pick it up, then wait for the page to settle. Not undone by webview.restore. ${TARGET_HELP} {submit:true} also presses Enter. ${WHICH}`,
      run: (
        target: unknown,
        text: string,
        options: Options & { submit?: boolean } = {},
      ) =>
        callPage(entryNamed(options.webview), 'fill', {
          target,
          text,
          options: { submit: options.submit, index: options.index },
        }),
    },
    'webview.waitFor': {
      maxArgs: 2,
      description: `Wait until a target is on the WebView page, or gone with {gone:true}, then wait for the page to settle. Default timeout 5000 ms; a timeout lists what is on the page. ${TARGET_HELP} ${WHICH}`,
      run: (
        target: unknown,
        options: Options & { gone?: boolean; timeoutMs?: number } = {},
      ) =>
        callPage(
          entryNamed(options.webview),
          'waitFor',
          { target, options: { gone: options.gone, timeoutMs: options.timeoutMs } },
          (options.timeoutMs ?? 5000) + 5000,
        ),
    },
    'webview.url': {
      maxArgs: 1,
      description: 'The URL a WebView is on, as it last reported it. Arguments: [name].',
      run: (name?: string) => {
        const entry = entryNamed(name)
        return { url: entry.url ?? null, allowed: isCurrentAllowed(entry) ?? null }
      },
    },
    'webview.reload': {
      maxArgs: 1,
      description:
        'Reload the page, and wait up to 10 s for it to load again. Arguments: [name].',
      run: async (name?: string) => {
        const entry = entryNamed(name)
        const webview = entry.ref.current
        if (!webview) throw new Error(`WebView "${entry.options.name}" is not mounted`)
        const loaded = new Promise<boolean>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            entry.onLoaded.delete(done)
            resolve(true)
          }
          const timer = setTimeout(() => {
            entry.onLoaded.delete(done)
            resolve(false)
          }, 10_000)
          entry.onLoaded.add(done)
        })
        entry.loaded = false
        webview.reload()
        return { reloaded: true, loaded: await loaded, url: entry.url ?? null }
      },
    },
    'webview.messages': {
      maxArgs: 2,
      description: `The last 100 messages in both directions, oldest first, with timestamps: page → app (onMessage) and app → page (postMessage, injectJavaScript, and what webview.send delivered). Bodies are cut at ${BODY_CHARS / 1024} KB (truncated:true, size); webview.message <id> returns one in full. Bodies are redacted by the WebView's redact option. Arguments: [name], {limit}. Without a name, every WebView's, merged by time.`,
      run: (first?: string | { limit?: number }, second?: { limit?: number }) => {
        const name = typeof first === 'string' ? first : undefined
        const options = (typeof first === 'string' ? second : first) ?? {}
        const all = (name === undefined ? entries() : [entryNamed(name)])
          .flatMap((entry) => entry.log)
          .sort((a, b) => a.id - b.id)
        return (options.limit !== undefined ? all.slice(-options.limit) : all).map(shown)
      },
    },
    'webview.message': {
      maxArgs: 1,
      description:
        'One logged message in full, by the id webview.messages shows (redacted like the log).',
      run: (id: number) => messageById(Number(id)),
    },
    'webview.send': {
      maxArgs: 2,
      description:
        'Deliver a message to the page as if the app had sent it (WebView postMessage): a string as is, anything else as JSON. Arguments: [name] <json>. Refused when the page is outside the allowed origins. It is logged, and not undone.',
      run: async (...args: unknown[]) => {
        const [entry, data] = nameAndData(args, 'webview.send')
        sendToPage(entry, bodyOf(data))
        return { sent: true }
      },
    },
    'webview.receive': {
      maxArgs: 2,
      description:
        "Run the app's onMessage handler with a fake page message, without the page sending it: a string as is, anything else as JSON. Arguments: [name] <json>. Then waits for the render. Errors from the handler come back as errors. Not undone: mock what the handler does with onRestore.",
      run: async (...args: unknown[]) => {
        const [entry, data] = nameAndData(args, 'webview.receive')
        if (!entry.handler)
          throw new Error(
            `WebView "${entry.options.name}" has no onMessage handler: pass wrap(onMessage) to the WebView`,
          )
        requireAllowed(entry)
        const body = bodyOf(data)
        record(entry, 'page→app', 'webview.receive', body)
        const result = await entry.handler({
          nativeEvent: {
            data: body,
            url: entry.url ?? '',
            title: '',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            lockIdentifier: 0,
            target: 0,
          },
        })
        await settle()
        return { delivered: true, ...(result === undefined ? {} : { result }) }
      },
    },
    'webview.restore': {
      maxArgs: 0,
      description:
        'Clear the message logs and drop any call still waiting for a reply. webview.press, fill and send change the page and the app and are not undone: reload the page, or mock host handlers with onRestore.',
      run: () => restoreAll(),
    },
  }
}
