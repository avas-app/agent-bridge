// The app side of the WebView adapter: a registry of WebViews, the message log,
// and the one fixed script behind every DOM call. The hook and the tools
// (react-native-webview.ts) are thin over this.
import { logToBridge } from '../runtime/logs'
import { webViewMark } from '../runtime/screen/webview-mark'
import { bootMain, pageMain } from './webview-page'

/** What the adapter needs from a react-native-webview instance. */
export type WebViewLike = {
  injectJavaScript: (script: string) => void
  postMessage: (data: string) => void
  reload: () => void
}

/**
 * Keeps secrets out of the message log. Either dotted paths into JSON message
 * bodies (`['token', 'user.phone']`), or a hook called for the whole body
 * (`path` is `''`) and every nested value of a JSON body with its dotted path;
 * what it returns is logged instead. A body that isn't JSON (a script from
 * `injectJavaScript`, plain text) can only be redacted by the hook.
 */
export type WebViewRedact =
  | string[]
  | ((webview: string, path: string, value: unknown) => unknown)

export type WebViewOptions = {
  /** What agents call this WebView: `webview.press`'s `webview` option, `webview.snapshot <name>`. */
  name: string
  /** Origins besides the page the WebView first loads that may be read and driven, e.g. `https://pay.example.com`. */
  allowedOrigins?: string[]
  redact?: WebViewRedact
  /** Your own `injectedJavaScriptBeforeDocumentLoaded`; it runs after the adapter's. */
  injectedJavaScriptBeforeDocumentLoaded?: string
}

export type MessageEntry = {
  id: number
  at: number
  webview: string
  direction: 'page→app' | 'app→page'
  via: 'onMessage' | 'postMessage' | 'injectJavaScript' | 'webview.send' | 'webview.receive'
  body: string
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type Ref = { current: WebViewLike | null }

export type Entry = {
  options: WebViewOptions
  ref: Ref
  url: string | undefined
  origin: string | undefined
  /** The origin of the first page the WebView reported. */
  initialOrigin: string | undefined
  loaded: boolean
  log: MessageEntry[]
  pending: Map<string, Pending>
  handler: ((event: unknown) => unknown) | undefined
  /** The instance whose methods are patched, and how to put them back. */
  patched: { instance: WebViewLike; undo: () => void } | null
  /** Loaded-state listeners for webview.reload. */
  onLoaded: Set<() => void>
}

export const LOG_CAPACITY = 100
export const BODY_CHARS = 2048
export const CALL_TIMEOUT_MS = 10_000

const registry = new Map<string, Entry>()
let nextId = 1

export const entries = (): Entry[] => [...registry.values()]

export function entryNamed(name?: string): Entry {
  if (name === undefined) {
    if (registry.size === 1) return registry.values().next().value as Entry
    if (!registry.size) throw new Error('No WebView is registered (useWebViewTools)')
    throw new Error(
      `Several WebViews are registered; say which: ${[...registry.keys()].join(', ')}`,
    )
  }
  const entry = registry.get(name)
  if (!entry)
    throw new Error(
      `Unknown WebView "${name}". Registered: ${[...registry.keys()].join(', ') || 'none'}`,
    )
  return entry
}

// "https://a.example.com/x?y" -> "https://a.example.com"; anything else as is.
const originOf = (value: string): string => {
  const found = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(value)
  return (found ? (found[1] as string) : value).toLowerCase()
}

export const allowedOrigins = (entry: Entry): string[] => {
  const list = [entry.initialOrigin, ...(entry.options.allowedOrigins ?? []).map(originOf)]
  return [...new Set(list.filter((o): o is string => !!o))]
}

const isAllowed = (entry: Entry, origin: string | undefined) =>
  origin !== undefined && allowedOrigins(entry).includes(origin.toLowerCase())

const REDACTED = '[redacted]'

function redactValue(
  redact: WebViewRedact,
  name: string,
  value: unknown,
  path: string,
  seen: object[] = [],
): unknown {
  if (typeof value === 'function') return value
  if (typeof redact === 'function') {
    if (path) value = redact(name, path, value)
  } else if (path && redact.some((p) => path === p || path.startsWith(`${p}.`))) {
    return REDACTED
  }
  if (typeof value !== 'object' || value === null || seen.includes(value)) return value
  const next = [...seen, value]
  const items = Object.entries(value).map(
    ([k, v]) => [k, redactValue(redact, name, v, path ? `${path}.${k}` : k, next)] as const,
  )
  return Array.isArray(value) ? items.map(([, v]) => v) : Object.fromEntries(items)
}

/** A message body as it is logged: redacted, and always a string. */
export function redactBody(entry: Entry, body: string): string {
  const { redact, name } = entry.options
  if (!redact) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // Not JSON: only the hook can say what in it is secret.
    if (typeof redact !== 'function') return body
    const out = redact(name, '', body)
    return typeof out === 'string' ? out : JSON.stringify(out)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    if (typeof redact !== 'function') return body
    const out = redact(name, '', parsed)
    return typeof out === 'string' ? out : JSON.stringify(out)
  }
  return JSON.stringify(redactValue(redact, name, parsed, ''))
}

export function record(
  entry: Entry,
  direction: MessageEntry['direction'],
  via: MessageEntry['via'],
  body: unknown,
): void {
  const text = typeof body === 'string' ? body : safeStringify(body)
  entry.log.push({
    id: nextId++,
    at: Date.now(),
    webview: entry.options.name,
    direction,
    via,
    body: redactBody(entry, text),
  })
  if (entry.log.length > LOG_CAPACITY) entry.log.shift()
}

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** A log entry as an agent reads it: the body cut at 2 KB, with its full size. */
export function shown(message: MessageEntry): Record<string, unknown> {
  const { body, ...rest } = message
  if (body.length <= BODY_CHARS) return { ...rest, body }
  return { ...rest, body: body.slice(0, BODY_CHARS), truncated: true, size: body.length }
}

export function messageById(id: number): MessageEntry {
  for (const entry of registry.values()) {
    const found = entry.log.find((m) => m.id === id)
    if (found) return found
  }
  throw new Error(`No message ${id} in the log (it keeps the last ${LOG_CAPACITY} per WebView)`)
}

const randomNonce = (): string => {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  const bytes = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// The page-side functions, as source: the fixed scripts.
const BOOT = `(${bootMain.toString()})(window,function(s){window.ReactNativeWebView.postMessage(s)});true;`
const PAGE = pageMain.toString()

/** JSON as a JS string literal, safe in any engine (U+2028/2029 escaped). */
const literal = (value: string): string =>
  JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

/** The script for one call: fixed source, arguments as a JSON string. */
export const callScript = (argsJson: string): string =>
  `(${PAGE})(window,${literal(argsJson)},function(s){window.ReactNativeWebView.postMessage(s)});true;`

// Puts the adapter's hooks on the WebView instance so the app's own
// postMessage and injectJavaScript calls land in the log. Ours go around them.
function attach(entry: Entry): void {
  const instance = entry.ref.current
  if (entry.patched && entry.patched.instance === instance) return
  entry.patched?.undo()
  entry.patched = null
  if (!instance) return
  const { postMessage, injectJavaScript } = instance
  const inject = injectJavaScript.bind(instance)
  const post = postMessage.bind(instance)
  instance.postMessage = (data: string) => {
    record(entry, 'app→page', 'postMessage', data)
    return post(data)
  }
  instance.injectJavaScript = (script: string) => {
    record(entry, 'app→page', 'injectJavaScript', script)
    return inject(script)
  }
  entry.patched = {
    instance,
    undo: () => {
      instance.postMessage = postMessage
      instance.injectJavaScript = injectJavaScript
    },
  }
  originals.set(entry, { inject, post })
}

// The unpatched methods, bound: what the adapter itself calls.
const originals = new WeakMap<Entry, { inject: (s: string) => void; post: (d: string) => void }>()

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'string' || !value.startsWith('{') || !value.includes('__agentBridge')) return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return parsed && parsed.__agentBridge === 1 ? parsed : null
  } catch {
    return null
  }
}

function onOwnMessage(entry: Entry, message: Record<string, unknown>): void {
  const origin = typeof message.origin === 'string' ? message.origin : undefined
  if (message.kind === 'state') {
    if (typeof message.url === 'string') entry.url = message.url
    if (origin) {
      entry.origin = origin
      entry.initialOrigin ??= origin.toLowerCase()
    }
    if (message.state === 'loading') entry.loaded = false
    if (message.state === 'loaded') {
      entry.loaded = true
      for (const listener of [...entry.onLoaded]) listener()
    }
  } else if (message.kind === 'log') {
    // Only errors reach the bridge; console.warn is left out on purpose.
    logToBridge('error', `[webview ${entry.options.name}] ${String(message.message)}`)
  } else if (message.kind === 'reply' && typeof message.nonce === 'string') {
    const pending = entry.pending.get(message.nonce)
    if (!pending) return
    entry.pending.delete(message.nonce)
    clearTimeout(pending.timer)
    if (message.ok === true && !isAllowed(entry, origin)) {
      // The page said it was somewhere else: whatever it read is dropped.
      pending.reject(new Error(`The page answered from ${String(origin)}, which is not allowed`))
    } else if (message.ok === true) pending.resolve(message.result)
    else pending.reject(new Error(String(message.error)))
  }
}

/** The props to spread on the WebView. */
export const webViewProps = (options: WebViewOptions) => ({
  injectedJavaScriptBeforeDocumentLoaded: `${webViewMark(options.name)}${BOOT}${options.injectedJavaScriptBeforeDocumentLoaded ?? ''}`,
})

/**
 * A WebView the app has set up. `mount` makes it reachable and `dispose` takes
 * it away again, so a Strict Mode remount registers it once more.
 */
export function register(ref: Ref, options: WebViewOptions) {
  const entry: Entry = {
    options,
    ref,
    url: undefined,
    origin: undefined,
    initialOrigin: undefined,
    loaded: false,
    log: [],
    pending: new Map(),
    handler: undefined,
    patched: null,
    onLoaded: new Set(),
  }

  const wrap = (onMessage?: (event: never) => unknown) => {
    entry.handler = onMessage as ((event: unknown) => unknown) | undefined
    return (event: { nativeEvent?: { data?: unknown } }) => {
      const data = event?.nativeEvent?.data
      // Our own traffic never reaches the app's handler.
      const own = asRecord(data)
      if (own) return onOwnMessage(entry, own)
      record(entry, 'page→app', 'onMessage', typeof data === 'string' ? data : safeStringify(data))
      return entry.handler?.(event)
    }
  }

  return {
    entry,
    wrap,
    mount: () => {
      const previous = registry.get(entry.options.name)
      if (previous && previous !== entry) {
        // A remount under the same name keeps the log an agent was reading.
        entry.log = previous.log
        previous.patched?.undo()
        dropPending(previous, 'The WebView was replaced')
      }
      registry.set(entry.options.name, entry)
      attach(entry)
    },
    dispose: () => {
      entry.patched?.undo()
      entry.patched = null
      dropPending(entry, 'The WebView was unmounted')
      if (registry.get(entry.options.name) === entry) registry.delete(entry.options.name)
    },
  }
}

function dropPending(entry: Entry, why: string) {
  for (const [nonce, pending] of entry.pending) {
    clearTimeout(pending.timer)
    pending.reject(new Error(why))
    entry.pending.delete(nonce)
  }
}

/** Runs one page operation and waits for its reply. */
export function callPage(
  entry: Entry,
  op: 'snapshot' | 'press' | 'fill' | 'waitFor',
  args: Record<string, unknown>,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<unknown> {
  const { name } = entry.options
  const webview = entry.ref.current
  if (!webview) return Promise.reject(new Error(`WebView "${name}" is not mounted`))
  attach(entry)
  const allowed = allowedOrigins(entry)
  if (!allowed.length)
    return Promise.reject(new Error(`WebView "${name}" has not loaded a page yet`))
  // Checked here as well as in the page, so a page that is known to be
  // elsewhere is never sent anything.
  if (entry.origin !== undefined && !isAllowed(entry, entry.origin))
    return Promise.reject(notAllowed(entry))
  const nonce = randomNonce()
  const script = callScript(JSON.stringify({ ...args, op, nonce, allowed }))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(nonce)
      reject(
        new Error(
          `No reply from WebView "${name}" in ${Math.round(timeoutMs / 1000)} s. Is a page loaded${entry.loaded ? '' : ' (it is still loading)'}?`,
        ),
      )
    }, timeoutMs)
    entry.pending.set(nonce, { resolve, reject, timer })
    try {
      ;(originals.get(entry)?.inject ?? webview.injectJavaScript.bind(webview))(script)
    } catch (error) {
      entry.pending.delete(nonce)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export const notAllowed = (entry: Entry) =>
  new Error(
    `WebView "${entry.options.name}" is on ${entry.origin ?? 'an unknown origin'}, which is not allowed (allowed: ${allowedOrigins(entry).join(', ') || 'none'}). Add it to allowedOrigins to read or drive it`,
  )

export function requireAllowed(entry: Entry): void {
  if (entry.origin !== undefined && !isAllowed(entry, entry.origin)) throw notAllowed(entry)
}

export const isCurrentAllowed = (entry: Entry): boolean | undefined =>
  entry.origin === undefined ? undefined : isAllowed(entry, entry.origin)

/** The unpatched postMessage, for messages the agent sends. */
export function sendToPage(entry: Entry, body: string): void {
  const webview = entry.ref.current
  if (!webview) throw new Error(`WebView "${entry.options.name}" is not mounted`)
  attach(entry)
  requireAllowed(entry)
  ;(originals.get(entry)?.post ?? webview.postMessage.bind(webview))(body)
  record(entry, 'app→page', 'webview.send', body)
}

/** Forgets the message logs and any call still waiting for a reply. */
export function restoreAll(): { cleared: number } {
  let cleared = 0
  for (const entry of registry.values()) {
    cleared += entry.log.length
    entry.log = []
    dropPending(entry, 'Cleared by webview.restore')
  }
  return { cleared }
}

/** Unregisters everything. For tests. */
export function resetWebViews(): void {
  for (const entry of registry.values()) {
    entry.patched?.undo()
    dropPending(entry, 'reset')
  }
  registry.clear()
  nextId = 1
}
