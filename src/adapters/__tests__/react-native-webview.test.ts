import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

import { startLogCapture } from '../../runtime/logs'
import type { ToolFn, Tools } from '../../runtime/types'
import { webviewTools } from '../react-native-webview'
import {
  BODY_CHARS,
  callScript,
  register,
  resetWebViews,
  type WebViewLike,
  type WebViewOptions,
  webViewProps,
} from '../webview-host'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

const ORIGIN = 'https://shop.example.com'

// A WebView whose page is a real DOM: injected scripts run in it, and what the
// page posts comes back through the handler the app gave the WebView.
function fakeWebView(html = '<button data-testid="pay">Pay</button><input data-testid="name">') {
  const win = new Window({ url: `${ORIGIN}/cart` })
  win.document.body.innerHTML = html
  const injected: string[] = []
  const posted: string[] = []
  let onMessage: ((event: unknown) => unknown) | undefined
  const toApp = (data: string) => onMessage?.({ nativeEvent: { data } })
  ;(win as any).ReactNativeWebView = { postMessage: (s: string) => void toApp(s) }
  const web = {
    // What the page does with an injected script; tests swap it.
    behave: (script: string) => void new Function('window', script)(win),
  }
  const view: WebViewLike & { reloads: number } = {
    reloads: 0,
    injectJavaScript: (script: string) => {
      injected.push(script)
      web.behave(script)
    },
    postMessage: (data: string) => void posted.push(data),
    reload: () => {
      view.reloads++
    },
  }
  return Object.assign(web, {
    win,
    view,
    injected,
    posted,
    connect: (handler: (event: unknown) => unknown) => (onMessage = handler),
    /** The page sends the app a message of its own. */
    pageSays: (data: unknown) => toApp(typeof data === 'string' ? data : JSON.stringify(data)),
    /** What the WebView runs before the page's scripts. */
    boot: (props: { injectedJavaScriptBeforeDocumentLoaded: string }) =>
      new Function('window', props.injectedJavaScriptBeforeDocumentLoaded)(win),
  })
}

// What useWebViewTools does, without React.
function mount(web: ReturnType<typeof fakeWebView>, options: WebViewOptions, appHandler?: (e: any) => void) {
  const host = register({ current: web.view }, options)
  host.mount()
  const props = webViewProps(options)
  web.connect(host.wrap(appHandler) as never)
  web.boot(props)
  web.win.dispatchEvent(new (web.win as any).Event('load'))
  return { host, props }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
let logs: ReturnType<typeof startLogCapture>
const tools = webviewTools()

beforeEach(() => {
  logs = startLogCapture()
  logs.capture.clear()
})
afterEach(() => {
  resetWebViews()
  logs.stop()
})

describe('routing and replies', () => {
  test('a call injects one fixed script with the arguments as a JSON string, and the reply resolves it', async () => {
    const web = fakeWebView()
    const seen: unknown[] = []
    mount(web, { name: 'checkout' }, (e) => void seen.push(e))
    const result = (await run(tools, 'webview.press', 'pay')) as any
    expect(result.element).toMatchObject({ testID: 'pay', text: 'Pay' })
    expect(web.injected).toHaveLength(1)
    // The source is the same on every call; only the JSON string argument differs.
    await run(tools, 'webview.press', 'pay')
    const fixed = (script: string) => script.replace(/window,"(?:[^"\\]|\\.)*",function/, 'window,ARGS,function')
    expect(fixed(web.injected[0]!)).toBe(fixed(web.injected[1]!))
    expect(web.injected[0]).not.toBe(web.injected[1]) // fresh nonce
    expect(web.injected[0]).toContain(callScript(JSON.stringify({ target: 'pay' })).slice(0, 40))
    // Our replies never reach the app.
    expect(seen).toEqual([])
  })

  test('hostile arguments are data, not code', async () => {
    const web = fakeWebView('<button>Go</button>')
    mount(web, { name: 'checkout' })
    await tick()
    ;(web.win as any).pwned = 0
    const evil = `"});window.pwned=1;//`
    await expect(run(tools, 'webview.press', evil)).rejects.toThrow('Nothing in the page matches')
    expect((web.win as any).pwned).toBe(0)
    expect(web.injected[0]).not.toContain('window.pwned=1;//"')
  })

  test('a reply with the wrong nonce is swallowed and resolves nothing', async () => {
    const web = fakeWebView()
    const seen: unknown[] = []
    mount(web, { name: 'checkout', }, (e) => seen.push(e))
    web.behave = () => {} // the page never answers
    const call = run(tools, 'webview.waitFor', 'pay', { timeoutMs: 1 })
    web.pageSays({ __agentBridge: 1, kind: 'reply', nonce: 'guess', origin: ORIGIN, ok: true, result: { found: true } })
    await tick()
    expect(seen).toEqual([])
    await expect(Promise.race([call, new Promise((r) => setTimeout(() => r('pending'), 50))])).resolves.toBe('pending')
  })

  test('a call that gets no reply times out with a hint', async () => {
    const web = fakeWebView()
    const { host } = mount(web, { name: 'checkout' })
    web.behave = () => {}
    const { callPage, entryNamed } = await import('../webview-host')
    await expect(callPage(entryNamed(), 'snapshot', {}, 20)).rejects.toThrow('No reply from WebView "checkout"')
  })

  test("the app's own messages still go through, and are logged", async () => {
    const web = fakeWebView()
    const seen: string[] = []
    mount(web, { name: 'checkout' }, (e) => seen.push(e.nativeEvent.data))
    await run(tools, 'webview.snapshot')
    web.pageSays({ type: 'ready' })
    await tick()
    expect(seen).toEqual(['{"type":"ready"}'])
    const log = (await run(tools, 'webview.messages')) as any[]
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ webview: 'checkout', direction: 'page→app', via: 'onMessage', body: '{"type":"ready"}' })
    expect(typeof log[0].at).toBe('number')
  })
})

describe('origins', () => {
  test('a page outside the allowed origins is listed as not allowed and never read', async () => {
    const web = fakeWebView()
    mount(web, { name: 'checkout' })
    expect(((await run(tools, 'webview.list')) as any[])[0]).toMatchObject({
      name: 'checkout',
      url: `${ORIGIN}/cart`,
      loaded: true,
      allowed: true,
      origins: [ORIGIN],
    })
    // The WebView navigates somewhere else.
    ;(web.win as any).happyDOM.setURL('https://evil.example.org/')
    web.win.dispatchEvent(new (web.win as any).Event('popstate'))
    await tick()
    expect(((await run(tools, 'webview.list')) as any[])[0]).toMatchObject({ allowed: false })
    const before = web.injected.length
    await expect(run(tools, 'webview.snapshot')).rejects.toThrow('not allowed')
    await expect(run(tools, 'webview.send', { a: 1 })).rejects.toThrow('not allowed')
    expect(web.injected.length).toBe(before)
    expect(web.posted).toEqual([])
  })

  test('allowedOrigins adds to the first origin', async () => {
    const web = fakeWebView()
    mount(web, { name: 'checkout', allowedOrigins: ['https://pay.example.com/'] })
    expect(((await run(tools, 'webview.list')) as any[])[0].origins).toEqual([ORIGIN, 'https://pay.example.com'])
  })

  test('the page answering from an origin that is not allowed drops its data', async () => {
    const web = fakeWebView()
    mount(web, { name: 'checkout' })
    web.behave = (script) => {
      const nonce = /"nonce\\":\\"([0-9a-f]+)/.exec(script)![1]
      web.pageSays({ __agentBridge: 1, kind: 'reply', nonce, origin: 'https://evil.example.org', ok: true, result: { secret: 1 } })
    }
    await expect(run(tools, 'webview.snapshot')).rejects.toThrow('which is not allowed')
  })
})

describe('message log', () => {
  test('logs both directions, keeps the last 100, and cuts bodies at 2 KB', async () => {
    const web = fakeWebView()
    mount(web, { name: 'checkout' })
    web.view.postMessage('hello') // the app talks to the page (patched by the adapter)
    web.view.injectJavaScript('true;')
    for (let i = 0; i < 100; i++) web.pageSays({ i })
    web.pageSays({ big: 'x'.repeat(5000) })
    await tick()
    const log = (await run(tools, 'webview.messages')) as any[]
    expect(log).toHaveLength(100)
    const big = log.at(-1)
    expect(big.truncated).toBe(true)
    expect(big.body).toHaveLength(BODY_CHARS)
    expect(big.size).toBeGreaterThan(5000)
    const full = (await run(tools, 'webview.message', big.id)) as any
    expect(full.body.length).toBe(big.size)
    // The two app → page messages were pushed out by the 100 that followed.
    expect(log.some((m) => m.direction === 'app→page')).toBe(false)
    expect(((await run(tools, 'webview.messages', 'checkout', { limit: 2 })) as any[]).map((m) => m.id)).toEqual(log.slice(-2).map((m) => m.id))
    expect(() => run(tools, 'webview.message', 99999)).toThrow('No message 99999')
  })

  test('app → page messages show how they were sent; the adapter’s own calls are not logged', async () => {
    const web = fakeWebView()
    mount(web, { name: 'checkout' })
    web.view.postMessage('{"type":"init"}')
    web.view.injectJavaScript('window.x = 1; true;')
    await run(tools, 'webview.snapshot')
    const log = (await run(tools, 'webview.messages')) as any[]
    expect(log.map((m) => [m.direction, m.via])).toEqual([
      ['app→page', 'postMessage'],
      ['app→page', 'injectJavaScript'],
    ])
    expect(web.posted).toEqual(['{"type":"init"}'])
  })

  test('redact by path, and by hook', async () => {
    const web = fakeWebView()
    mount(web, { name: 'checkout', redact: ['token', 'user.phone'] })
    web.pageSays({ token: 'secret', user: { phone: '555', name: 'Ada' } })
    web.view.postMessage('not json, token=secret')
    await tick()
    const log = (await run(tools, 'webview.messages')) as any[]
    expect(JSON.parse(log[0].body)).toEqual({ token: '[redacted]', user: { phone: '[redacted]', name: 'Ada' } })
    // A path list can't see into text that isn't JSON.
    expect(log[1].body).toBe('not json, token=secret')
    expect(((await run(tools, 'webview.message', log[0].id)) as any).body).not.toContain('secret')

    resetWebViews()
    const other = fakeWebView()
    mount(other, {
      name: 'pay',
      redact: (_webview, path, value) => (path === 'card' || (path === '' && typeof value === 'string') ? '***' : value),
    })
    other.pageSays({ card: '4242', ok: true })
    other.view.injectJavaScript('window.card = "4242"')
    await tick()
    const hooked = (await run(tools, 'webview.messages')) as any[]
    expect(JSON.parse(hooked[0].body)).toEqual({ card: '***', ok: true })
    expect(hooked[1].body).toBe('***')
  })
})

describe('send and receive', () => {
  test('send delivers a message to the page and logs it', async () => {
    const web = fakeWebView()
    mount(web, { name: 'checkout' })
    await run(tools, 'webview.send', { type: 'auth', ok: true })
    await run(tools, 'webview.send', 'checkout', 'plain text')
    expect(web.posted).toEqual(['{"type":"auth","ok":true}', 'plain text'])
    const log = (await run(tools, 'webview.messages')) as any[]
    expect(log.map((m) => [m.via, m.body])).toEqual([
      ['webview.send', '{"type":"auth","ok":true}'],
      ['webview.send', 'plain text'],
    ])
  })

  test('receive runs the app handler with a fake page message', async () => {
    const web = fakeWebView()
    const got: any[] = []
    mount(web, { name: 'checkout' }, (e) => void got.push(e.nativeEvent))
    expect(await run(tools, 'webview.receive', { type: 'done' })).toEqual({ delivered: true })
    expect(got[0]).toMatchObject({ data: '{"type":"done"}', url: `${ORIGIN}/cart` })
    expect(((await run(tools, 'webview.messages')) as any[])[0]).toMatchObject({ via: 'webview.receive', direction: 'page→app' })
  })

  test('receive errors when the app never wrapped a handler, and surfaces handler errors', async () => {
    const web = fakeWebView()
    mount(web, { name: 'checkout' })
    await expect(run(tools, 'webview.receive', { a: 1 })).rejects.toThrow('has no onMessage handler')
    mount(web, { name: 'checkout' }, () => {
      throw new Error('bad message')
    })
    await expect(run(tools, 'webview.receive', { a: 1 })).rejects.toThrow('bad message')
  })

  test('several WebViews need a name', async () => {
    const a = fakeWebView()
    const b = fakeWebView()
    mount(a, { name: 'a' })
    mount(b, { name: 'b' })
    await expect(run(tools, 'webview.send', { x: 1 })).rejects.toThrow('Several WebViews are registered; say which: a, b')
    await run(tools, 'webview.send', 'b', { x: 1 })
    expect(b.posted).toEqual(['{"x":1}'])
    expect(a.posted).toEqual([])
    expect(() => run(tools, 'webview.url', 'nope')).toThrow('Unknown WebView "nope". Registered: a, b')
  })
})

describe('page errors', () => {
  test('console.error and uncaught errors reach bridge.logs tagged with the WebView; console.warn does not', async () => {
    const web = fakeWebView()
    mount(web, { name: 'checkout' })
    web.win.console.error('payment failed')
    web.win.console.warn('just a warning')
    await tick()
    const entries = logs.capture.read()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'error', message: '[webview checkout] payment failed' })
  })

  test('an error during a tool call is tagged with the tool', async () => {
    const web = fakeWebView()
    mount(web, { name: 'checkout' })
    const end = logs.capture.begin('webview.press')
    web.win.console.error('boom')
    await tick()
    end()
    expect(logs.capture.takeErrors()[0]).toMatchObject({ during: 'webview.press' })
  })
})

describe('url, reload and restore', () => {
  test('url and reload', async () => {
    const web = fakeWebView()
    mount(web, { name: 'checkout' })
    expect(await run(tools, 'webview.url')).toEqual({ url: `${ORIGIN}/cart`, allowed: true })
    const reloading = run(tools, 'webview.reload') as Promise<any>
    await tick()
    expect(web.view.reloads).toBe(1)
    web.win.dispatchEvent(new (web.win as any).Event('load'))
    expect(await reloading).toMatchObject({ reloaded: true, loaded: true })
  })

  test('restore clears the logs and drops calls in flight', async () => {
    const web = fakeWebView()
    mount(web, { name: 'checkout' })
    web.pageSays({ a: 1 })
    await run(tools, 'webview.send', 'x')
    await tick()
    web.behave = () => {}
    const waiting = run(tools, 'webview.snapshot') as Promise<unknown>
    const outcome = waiting.catch((e: Error) => e.message)
    expect(await run(tools, 'webview.restore')).toEqual({ cleared: 2 })
    expect(await outcome).toBe('Cleared by webview.restore')
    expect(await run(tools, 'webview.messages')).toEqual([])
  })

  test('unmounting unregisters; a remount under the same name keeps the log', async () => {
    const web = fakeWebView()
    const first = mount(web, { name: 'checkout' })
    web.pageSays({ a: 1 })
    await tick()
    first.host.dispose()
    expect(await run(tools, 'webview.list')).toEqual([])
    const again = mount(fakeWebView(), { name: 'checkout' })
    expect(again.host.entry.log).toHaveLength(0)
  })
})
