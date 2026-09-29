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
  /** Your own `injectedJavaScriptBeforeContentLoaded`; it runs after the adapter's. */
  injectedJavaScriptBeforeContentLoaded?: string
  /** The adapter listens to these; pass yours here so spreading `props` doesn't replace them. */
  onLoadStart?: (event: NativeEvent) => void
  onLoadEnd?: (event: NativeEvent) => void
  onNavigationStateChange?: (event: NativeNavState) => void
}

/** What react-native-webview tells the app, from native code, not from the page. */
export type NativeEvent = { nativeEvent?: { url?: string; isTopFrame?: boolean } }
export type NativeNavState = { url?: string; loading?: boolean }

export type MessageEntry = {
  id: number
  at: number
  webview: string
  direction: 'page→app' | 'app→page'
  via: 'onMessage' | 'postMessage' | 'injectJavaScript' | 'webview.send' | 'webview.receive'
  body: string
}

type Pending = {
  op: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type Ref = { current: WebViewLike | null }

export type Entry = {
  options: WebViewOptions
  ref: Ref
  /** From native events (`nativeEvent.url`), never from what a page says about itself. */
  url: string | undefined
  origin: string | undefined
  /** The origin of the first top-level page native code reported. */
  initialOrigin: string | undefined
  loaded: boolean
  /** The current document's boot script has checked in, from an allowed origin. */
  handshake: boolean
  /** Native reported the current document finished loading. */
  nativeLoaded: boolean
  warnedDuplicate: boolean
  /** Secret shared with the main-frame script; every adapter message must carry it. */
  token: string
  /** Called when the token changes, so the hook renders the new props. */
  onRotate: (() => void) | undefined
  onHandshake: Set<() => void>
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

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' }

/**
 * The origin of a URL as browsers write it: scheme, host and non-default port,
 * lower case, without credentials. Anything that isn't http(s)/ws(s) (about:,
 * data:, file:, an html string) is the opaque origin `null`.
 */
export function originOf(value: string): string {
  const found = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)/i.exec(value.trim())
  if (!found) return 'null'
  const scheme = (found[1] as string).toLowerCase()
  if (!(scheme in DEFAULT_PORTS)) return 'null'
  // Anything before the last "@" is credentials, not the host.
  const authority = (found[2] as string).slice((found[2] as string).lastIndexOf('@') + 1).toLowerCase()
  const port = /:(\d*)$/.exec(authority)
  const host = port ? authority.slice(0, -port[0].length) : authority
  if (!host) return 'null'
  const keep = port?.[1] && port[1] !== DEFAULT_PORTS[scheme] ? `:${port[1]}` : ''
  return `${scheme}//${host}${keep}`
}

// The opaque origin `null` is every data: page and every html string, so it is
// allowed only when the app lists it in allowedOrigins.
export const allowedOrigins = (entry: Entry): string[] => {
  const explicit = (entry.options.allowedOrigins ?? []).map((o) =>
    o.trim().toLowerCase() === 'null' ? 'null' : originOf(o),
  )
  const initial = entry.initialOrigin && entry.initialOrigin !== 'null' ? [entry.initialOrigin] : []
  return [...new Set([...initial, ...explicit])]
}

const isAllowed = (entry: Entry, origin: string | undefined) =>
  origin !== undefined && allowedOrigins(entry).includes(origin)

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
// The token is a literal inside this script and never reaches `window`. The
// native postMessage is captured now, before the page's own scripts run.
const bootScript = (token: string) =>
  `(function(){var rn=window.ReactNativeWebView,p=rn&&rn.postMessage&&rn.postMessage.bind(rn);(${bootMain.toString()})(window,function(s){(p||window.ReactNativeWebView.postMessage.bind(window.ReactNativeWebView))(s)},${JSON.stringify(token)})})();true;`
const PAGE = pageMain.toString()

/** JSON as a JS string literal, safe in any engine (U+2028/2029 escaped). */
const literal = (value: string): string =>
  JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

/** The script for one call: fixed source, arguments as a JSON string. */
export const callScript = (argsJson: string): string =>
  `(${PAGE})(window,${literal(argsJson)},function(s){window.ReactNativeWebView.postMessage(s)});true;`


// Puts the adapter's hooks on the WebView instance so the app's own
// postMessage and injectJavaScript calls land in the log. Ours go around them.
// They stay on until the WebView unmounts (webview.restore leaves them).
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

/** Tunable for tests. */
export const timing = { handshakeMs: 3000 }

const PAGE_LOG_CHARS = 500

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'string' || !value.startsWith('{') || !value.includes('__agentBridge')) return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return parsed && parsed.__agentBridge === 1 ? parsed : null
  } catch {
    return null
  }
}

/** A new top-level document: what was waiting on the old one is settled. */
function navigated(entry: Entry, url: string | undefined): void {
  entry.handshake = false
  entry.nativeLoaded = false
  entry.loaded = false
  if (url !== undefined) {
    entry.url = url
    entry.origin = originOf(url)
    entry.initialOrigin ??= entry.origin
  }
  for (const [nonce, pending] of [...entry.pending]) {
    entry.pending.delete(nonce)
    clearTimeout(pending.timer)
    // A press or fill that navigates has done its job; a wait can't continue
    // on a page it never saw, so the agent asks again.
    if (pending.op === 'press' || pending.op === 'fill')
      pending.resolve({ navigated: true, url: entry.url ?? null })
    else
      pending.reject(
        new Error(
          `The page navigated to ${entry.url ?? 'another page'} during webview.${pending.op}; call it again on the new page`,
        ),
      )
  }
}

function rotateToken(entry: Entry): void {
  entry.token = randomNonce()
  entry.onRotate?.()
}

/** What native code says about the top-level page. */
function seeNative(
  entry: Entry,
  event: { nativeEvent?: { url?: string; isTopFrame?: boolean } } | undefined,
  kind: 'start' | 'end' | 'nav' | 'message',
): boolean {
  const info = event?.nativeEvent
  if (info?.isTopFrame === false || typeof info?.url !== 'string') return false
  const origin = originOf(info.url)
  entry.initialOrigin ??= origin
  if (kind === 'start' || origin !== entry.origin) navigated(entry, info.url)
  // A page that isn't allowed ran the script that carries the token, so it
  // may have seen it: the next pages get a new one.
  if (!isAllowed(entry, origin) && kind !== 'message') rotateToken(entry)
  else entry.url = info.url
  if (kind === 'end') {
    entry.nativeLoaded = true
    entry.loaded = true
    for (const listener of [...entry.onLoaded]) listener()
  }
  return true
}

function onOwnMessage(
  entry: Entry,
  message: Record<string, unknown>,
  event: { nativeEvent?: { url?: string; isTopFrame?: boolean } },
): void {
  // Only what native code says counts: the page's own claims about where it is
  // are ignored. From anywhere but an allowed top-level page, nothing is used.
  // Forged by a frame that never saw the token, or left over from before a rotation.
  if (message.t !== entry.token) return
  if (!seeNative(entry, event, 'message')) return
  if (!isAllowed(entry, entry.origin)) return
  const url = event.nativeEvent?.url as string
  if (message.kind === 'state') {
    if (message.state === 'loading') navigated(entry, url)
    if (message.state === 'loaded') {
      entry.loaded = true
      for (const listener of [...entry.onLoaded]) listener()
    }
    entry.handshake = true
    for (const listener of [...entry.onHandshake]) listener()
  } else if (message.kind === 'log') {
    // Only errors reach the bridge; console.warn is left out on purpose. It is
    // page output: cut, on one line, and labelled so it can't pass for the app's.
    const text = String(message.message).replace(/\s*[\r\n]+\s*/g, ' ⏎ ').slice(0, PAGE_LOG_CHARS)
    logToBridge('error', `[webview ${entry.options.name}, page output] ${text}`)
  } else if (message.kind === 'reply' && typeof message.nonce === 'string') {
    const pending = entry.pending.get(message.nonce)
    if (!pending) return
    entry.pending.delete(message.nonce)
    clearTimeout(pending.timer)
    if (message.ok === true) pending.resolve(message.result)
    else pending.reject(new Error(String(message.error)))
  }
}

/**
 * A WebView the app has set up. `mount` makes it reachable and `dispose` takes
 * it away again; both are safe to repeat, so a Strict Mode remount registers it
 * once.
 */
export function register(ref: Ref, options: WebViewOptions) {
  const entry: Entry = {
    options,
    ref,
    url: undefined,
    origin: undefined,
    initialOrigin: undefined,
    loaded: false,
    handshake: false,
    nativeLoaded: false,
    warnedDuplicate: false,
    token: randomNonce(),
    onRotate: undefined,
    onHandshake: new Set(),
    log: [],
    pending: new Map(),
    handler: undefined,
    patched: null,
    onLoaded: new Set(),
  }

  const wrap = (onMessage?: (event: never) => unknown) => {
    entry.handler = onMessage as ((event: unknown) => unknown) | undefined
    return (event: { nativeEvent?: { data?: unknown; url?: string; isTopFrame?: boolean } }) => {
      const data = event?.nativeEvent?.data
      // Our own traffic never reaches the app's handler.
      const own = asRecord(data)
      if (own) return onOwnMessage(entry, own, event)
      record(entry, 'page→app', 'onMessage', typeof data === 'string' ? data : safeStringify(data))
      return entry.handler?.(event)
    }
  }

  // The props to spread: the boot script, and the load events that tell the
  // adapter, from native code, which page it is talking to.
  const props = () => ({
    injectedJavaScriptBeforeContentLoaded: `${webViewMark(entry.options.name)}${bootScript(entry.token)}${entry.options.injectedJavaScriptBeforeContentLoaded ?? ''}`,
    // Forced: in a sub-frame the script's token would be in reach of a page that isn't the app's.
    injectedJavaScriptBeforeContentLoadedForMainFrameOnly: true as const,
    onLoadStart: (event: NativeEvent) => {
      seeNative(entry, event, 'start')
      entry.options.onLoadStart?.(event)
    },
    onLoadEnd: (event: NativeEvent) => {
      seeNative(entry, event, 'end')
      entry.options.onLoadEnd?.(event)
    },
    onNavigationStateChange: (state: NativeNavState) => {
      seeNative(entry, { nativeEvent: state }, 'nav')
      entry.options.onNavigationStateChange?.(state)
    },
  })

  return {
    entry,
    wrap,
    props,
    mount: () => {
      const name = entry.options.name
      const existing = registry.get(name)
      if (existing && existing !== entry) {
        // Two live WebViews under one name would steal each other's calls.
        if (!entry.warnedDuplicate) {
          entry.warnedDuplicate = true
          console.error(
            `agent-bridge: a WebView named "${name}" is already registered; this one is not reachable. Give each WebView its own name.`,
          )
        }
        return
      }
      entry.warnedDuplicate = false
      registry.set(name, entry)
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

export const notAllowed = (entry: Entry) =>
  new Error(
    `WebView "${entry.options.name}" is on ${entry.origin ?? 'an unknown origin'}, which is not allowed (allowed: ${allowedOrigins(entry).join(', ') || 'none'}). Add it to allowedOrigins to read or drive it`,
  )

const handshakeError = (entry: Entry) =>
  new Error(
    entry.nativeLoaded
      ? `WebView "${entry.options.name}" loaded but its page script did not check in. Spread useWebViewTools' props and pass wrap(onMessage) as onMessage; if you set your own injectedJavaScriptBeforeContentLoaded, pass it through useWebViewTools options instead`
      : `WebView "${entry.options.name}" is still loading`,
  )

/** Why nothing may be sent to or read from the page right now, if so. */
function refusal(entry: Entry): Error | null {
  if (entry.origin === undefined)
    return new Error(`WebView "${entry.options.name}" has not loaded a page yet`)
  if (!isAllowed(entry, entry.origin)) return notAllowed(entry)
  return null
}

export function requireVerified(entry: Entry): void {
  const why = refusal(entry) ?? (entry.handshake ? null : handshakeError(entry))
  if (why) throw why
}

export const isCurrentAllowed = (entry: Entry): boolean | undefined =>
  entry.origin === undefined ? undefined : isAllowed(entry, entry.origin)

// Waits for the current document's script to check in.
function awaitHandshake(entry: Entry): Promise<void> {
  return new Promise((resolve, reject) => {
    const settleNow = () => {
      const why = refusal(entry)
      if (why) return done(why)
      if (entry.handshake) return done()
    }
    const timer = setTimeout(() => done(refusal(entry) ?? handshakeError(entry)), timing.handshakeMs)
    const done = (error?: Error) => {
      clearTimeout(timer)
      entry.onHandshake.delete(settleNow)
      if (error) reject(error)
      else resolve()
    }
    entry.onHandshake.add(settleNow)
    settleNow()
  })
}

/** Runs one page operation and waits for its reply. */
export async function callPage(
  entry: Entry,
  op: 'snapshot' | 'press' | 'fill' | 'waitFor',
  args: Record<string, unknown>,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<unknown> {
  const { name } = entry.options
  if (!entry.ref.current) throw new Error(`WebView "${name}" is not mounted`)
  attach(entry)
  // Native code has to have said where the page is, and the page script has to
  // have checked in from there, before anything is sent to it.
  await awaitHandshake(entry)
  const webview = entry.ref.current
  if (!webview) throw new Error(`WebView "${name}" is not mounted`)
  requireVerified(entry)
  const allowed = allowedOrigins(entry)
  const nonce = randomNonce()
  const script = callScript(JSON.stringify({ ...args, op, nonce, allowed, token: entry.token }))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(nonce)
      reject(
        new Error(
          `No reply from WebView "${name}" in ${Math.round(timeoutMs / 1000)} s. Is a page loaded${entry.loaded ? '' : ' (it is still loading)'}?`,
        ),
      )
    }, timeoutMs)
    entry.pending.set(nonce, { op, resolve, reject, timer })
    try {
      ;(originals.get(entry)?.inject ?? webview.injectJavaScript.bind(webview))(script)
    } catch (error) {
      entry.pending.delete(nonce)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** The unpatched postMessage, for messages the agent sends. */
export function sendToPage(entry: Entry, body: string): void {
  const webview = entry.ref.current
  if (!webview) throw new Error(`WebView "${entry.options.name}" is not mounted`)
  attach(entry)
  requireVerified(entry)
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
  timing.handshakeMs = 3000
}
