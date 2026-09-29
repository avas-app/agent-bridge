import { afterEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

import { bootMain, pageMain } from '../webview-page'

const ORIGIN = 'https://shop.example.com'

function page(html: string, url = `${ORIGIN}/cart`) {
  const win = new Window({ url })
  win.document.body.innerHTML = html
  return win
}

// Runs the injected source itself, as the WebView would.
async function call(win: Window, args: Record<string, unknown>, allowed = [ORIGIN]) {
  const src = pageMain.toString()
  const posted: string[] = []
  const done = new Promise<Record<string, unknown>>((resolve) => {
    const fn = new Function(`return (${src})`)()
    fn(win, JSON.stringify({ nonce: 'n1', allowed, ...args }), (s: string) => {
      posted.push(s)
      resolve(JSON.parse(s))
    })
  })
  const reply = await done
  expect(reply).toMatchObject({ __agentBridge: 1, kind: 'reply', nonce: 'n1' })
  return reply as { ok: boolean; result?: any; error?: string; origin: string }
}

const open: Window[] = []
const make = (html: string, url?: string) => {
  const w = page(html, url)
  open.push(w)
  return w
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((w) => w.happyDOM.close()))
})

describe('snapshot', () => {
  test('lists buttons, links, inputs and text with ids, labels and state', async () => {
    const win = make(`
      <h1>Checkout</h1>
      <p>Total: <b>$12</b></p>
      <button data-testid="pay" class="x">Pay now</button>
      <button data-cy="cancel" disabled>Cancel</button>
      <a href="/terms" aria-label="Terms of service">Terms</a>
      <label for="email">Email</label><input id="email" placeholder="you@example.com" value="a@b.c">
      <input type="password" value="hunter2" data-test-id="pw">
      <input type="checkbox" checked aria-label="Gift wrap">
      <div data-testid="banner"></div>
      <div hidden><button>Hidden</button></div>
      <script>var x = "not text"</script>`)
    const { result } = await call(win, { op: 'snapshot' })
    expect(result.url).toBe(`${ORIGIN}/cart`)
    const els = result.elements as Array<Record<string, unknown>>
    const by = (f: (e: Record<string, unknown>) => boolean) => els.find(f)
    expect(by((e) => e.text === 'Checkout')).toMatchObject({ kind: 'text' })
    // Inline elements are part of their parent's text.
    expect(by((e) => e.kind === 'text' && String(e.text).startsWith('Total'))).toMatchObject({ text: 'Total: $12' })
    expect(els.filter((e) => e.text === '$12')).toHaveLength(0)
    expect(by((e) => e.testID === 'pay')).toMatchObject({ kind: 'button', text: 'Pay now', role: 'button' })
    expect(by((e) => e.testID === 'cancel')).toMatchObject({ disabled: true })
    expect(by((e) => e.role === 'link')).toMatchObject({ kind: 'button', label: 'Terms of service' })
    expect(by((e) => e.placeholder === 'you@example.com')).toMatchObject({
      kind: 'input',
      label: 'Email',
      value: 'a@b.c',
      editable: true,
    })
    expect(by((e) => e.testID === 'pw')).toMatchObject({ kind: 'input', value: '[hidden]' })
    expect(by((e) => e.label === 'Gift wrap')).toMatchObject({ kind: 'button', role: 'checkbox', checked: true })
    expect(by((e) => e.testID === 'banner')).toMatchObject({ kind: 'view' })
    expect(els.some((e) => e.text === 'Hidden' || e.text === 'not text')).toBe(false)
  })

  test('pierces open shadow roots', async () => {
    const win = make('<x-card id="c"></x-card>')
    const root = win.document.getElementById('c')!.attachShadow({ mode: 'open' })
    root.innerHTML = '<button data-testid="in-shadow">Inside</button>'
    const { result } = await call(win, { op: 'snapshot' })
    expect(result.elements).toContainEqual(expect.objectContaining({ testID: 'in-shadow', text: 'Inside' }))

    let clicked = 0
    root.querySelector('button')!.addEventListener('click', () => clicked++)
    const pressed = await call(win, { op: 'press', target: 'in-shadow' })
    expect(pressed.ok).toBe(true)
    expect(clicked).toBe(1)
  })

  test('reads same-origin iframes and marks cross-origin ones', async () => {
    const win = make('<iframe id="same"></iframe><iframe id="other" src="https://ads.example.net/x"></iframe>')
    const same = win.document.getElementById('same') as unknown as { contentDocument: Document }
    same.contentDocument.body.innerHTML = '<button data-testid="framed">In frame</button>'
    const { result } = await call(win, { op: 'snapshot' })
    expect(result.elements).toContainEqual(expect.objectContaining({ testID: 'framed', frame: 'same' }))
    expect(result.elements).toContainEqual(
      expect.objectContaining({ kind: 'iframe', note: 'iframe (cross-origin, not reachable)' }),
    )
  })
})

describe('origin', () => {
  test('a page outside the allowed origins is refused before anything is read', async () => {
    const win = make('<button data-testid="secret">Card 4242</button>', 'https://evil.example.org/')
    let touched = false
    const query = win.document.querySelectorAll.bind(win.document)
    win.document.querySelectorAll = ((...a: [string]) => ((touched = true), query(...a))) as never
    const reply = await call(win, { op: 'snapshot' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('https://evil.example.org is not allowed')
    expect(reply.error).not.toContain('4242')
    expect(touched).toBe(false)
    expect((await call(win, { op: 'press', target: 'secret' })).ok).toBe(false)
  })

  test('an app allowlist adds origins', async () => {
    const win = make('<b>hi</b>', 'https://pay.example.com/')
    expect((await call(win, { op: 'snapshot' }, [ORIGIN, 'https://pay.example.com'])).ok).toBe(true)
  })
})

describe('press', () => {
  test('matches like screen.*: testID, then label, then text, then role', async () => {
    const win = make(`
      <button aria-label="Save">Store</button>
      <button data-testid="Save">by id</button>
      <button>Save draft</button>
      <div role="tab">Details</div>`)
    const hits: string[] = []
    for (const b of Array.from(win.document.querySelectorAll('button, div')))
      b.addEventListener('click', () => hits.push(b.textContent ?? ''))
    await call(win, { op: 'press', target: 'Save' })
    expect(hits).toEqual(['by id'])
    await call(win, { op: 'press', target: 'Details' })
    // `tab` as a role, only when nothing else matches it.
    await call(win, { op: 'press', target: 'tab' })
    expect(hits).toEqual(['by id', 'Details', 'Details'])
  })

  test('says what is on the page when nothing matches, and asks for an index on several', async () => {
    const win = make('<button>One</button><button>Two</button>')
    const none = await call(win, { op: 'press', target: 'Three' })
    expect(none.error).toContain('Nothing in the page matches "Three"')
    expect(none.error).toContain('button "One"')
    const many = await call(win, { op: 'press', target: { role: 'button' } })
    expect(many.error).toContain('matches 2 elements')
    const second = await call(win, { op: 'press', target: { role: 'button', index: 1 } })
    expect(second.result.element.text).toBe('Two')
    expect((await call(win, { op: 'press', target: { nope: 1 } })).error).toContain('Unknown target key "nope"')
  })

  test('refuses disabled elements unless forced', async () => {
    const win = make('<button data-testid="b" disabled>Go</button>')
    expect((await call(win, { op: 'press', target: 'b' })).error).toContain('disabled')
    expect((await call(win, { op: 'press', target: 'b', options: { force: true } })).ok).toBe(true)
  })

  test('returns only after the DOM has been quiet for 100 ms', async () => {
    const win = make('<button data-testid="go">Go</button><div id="out"></div>')
    const out = win.document.getElementById('out')!
    win.document.querySelector('button')!.addEventListener('click', () => {
      // A render that keeps changing for 250 ms.
      let n = 0
      const tick = () => {
        out.textContent = `step ${++n}`
        if (n < 5) setTimeout(tick, 50)
      }
      tick()
    })
    const t0 = Date.now()
    const { result } = await call(win, { op: 'press', target: 'go' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300)
    expect(out.textContent).toBe('step 5')
    expect(result.settled.capped).toBe(false)
  })

  test('gives up settling after 2 s of constant change', async () => {
    const win = make('<button data-testid="go">Go</button><div id="out"></div>')
    const out = win.document.getElementById('out')!
    let timer: ReturnType<typeof setInterval>
    win.document.querySelector('button')!.addEventListener('click', () => {
      let n = 0
      timer = setInterval(() => (out.textContent = String(n++)), 20)
    })
    const { result } = await call(win, { op: 'press', target: 'go' })
    clearInterval(timer!)
    expect(result.settled.capped).toBe(true)
    expect(result.settled.ms).toBeLessThan(2500)
  })
})

describe('fill', () => {
  // What React does: it tracks `value` on the node, so a plain `el.value = x`
  // followed by an event is ignored as "unchanged".
  function controlled(win: Window, el: HTMLInputElement) {
    const proto = Object.getPrototypeOf(el)
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
    const getter = Object.getOwnPropertyDescriptor(proto, 'value')!.get!
    let tracked = ''
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: () => getter.call(el),
      set: (v: string) => {
        tracked = v
        setter.call(el, v)
      },
    })
    const seen: string[] = []
    el.addEventListener('input', () => {
      if (getter.call(el) !== tracked) seen.push(getter.call(el))
    })
    return seen
  }

  test('uses the native setter and fires input and change', async () => {
    const win = make('<input data-testid="name" placeholder="Name">')
    const el = win.document.querySelector('input') as unknown as HTMLInputElement
    const seen = controlled(win, el)
    const events: string[] = []
    el.addEventListener('change', () => events.push('change'))
    const { result } = await call(win, { op: 'fill', target: 'name', text: 'Ada' })
    expect(seen).toEqual(['Ada'])
    expect(events).toEqual(['change'])
    expect(result.filled).toBe('Ada')
    expect(result.element).toMatchObject({ kind: 'input', value: 'Ada' })
  })

  test('works on textarea and select, refuses buttons', async () => {
    const win = make('<textarea data-testid="t"></textarea><select data-testid="s"><option>a</option><option>b</option></select><button>Go</button>')
    await call(win, { op: 'fill', target: 't', text: 'line' })
    expect((win.document.querySelector('textarea') as unknown as HTMLTextAreaElement).value).toBe('line')
    await call(win, { op: 'fill', target: 's', text: 'b' })
    expect((win.document.querySelector('select') as unknown as HTMLSelectElement).value).toBe('b')
    expect((await call(win, { op: 'fill', target: 'Go', text: 'x' })).error).toContain('not an input')
  })
})

describe('fill secrets', () => {
  test('a password fill is not echoed back', async () => {
    const win = make('<input type="password" data-testid="pw"><input data-testid="user">')
    const pw = await call(win, { op: 'fill', target: 'pw', text: 'hunter2' })
    expect(pw.result.filled).toBe('[redacted]')
    expect(JSON.stringify(pw.result)).not.toContain('hunter2')
    expect((win.document.querySelector('[data-testid=pw]') as unknown as HTMLInputElement).value).toBe('hunter2')
    expect((await call(win, { op: 'fill', target: 'user', text: 'ada' })).result.filled).toBe('ada')
  })
})

describe('settle in iframes', () => {
  test('waits for changes inside a same-origin iframe', async () => {
    const win = make('<button data-testid="go">Go</button><iframe id="f"></iframe>')
    const frame = (win.document.getElementById('f') as unknown as { contentDocument: Document }).contentDocument
    frame.body.innerHTML = '<p id="in">0</p>'
    win.document.querySelector('button')!.addEventListener('click', () => {
      let n = 0
      const tick = () => {
        frame.getElementById('in')!.textContent = String(++n)
        if (n < 5) setTimeout(tick, 50)
      }
      tick()
    })
    const t0 = Date.now()
    await call(win, { op: 'press', target: 'go' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300)
    expect(frame.getElementById('in')!.textContent).toBe('5')
  })
})

describe('waitFor', () => {
  test('resolves when a target appears, and when it is gone', async () => {
    const win = make('<div id="root"></div>')
    setTimeout(() => (win.document.getElementById('root')!.innerHTML = '<p data-testid="done">Paid</p>'), 120)
    const appeared = await call(win, { op: 'waitFor', target: 'done' })
    expect(appeared.result).toMatchObject({ found: true })
    setTimeout(() => (win.document.getElementById('root')!.innerHTML = ''), 80)
    const gone = await call(win, { op: 'waitFor', target: 'done', options: { gone: true } })
    expect(gone.result).toMatchObject({ found: false })
  })

  test('times out with what is on the page', async () => {
    const win = make('<p>Hello</p>')
    const reply = await call(win, { op: 'waitFor', target: 'Never', options: { timeoutMs: 150 } })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('Timed out after 150 ms')
    expect(reply.error).toContain('text "Hello"')
  })
})

describe('bootMain', () => {
  test('reports console.error, uncaught errors, rejections and navigation; not console.warn', () => {
    const win = make('')
    const sent: any[] = []
    ;(win as any).ReactNativeWebView = {}
    const fn = new Function(`return (${bootMain.toString()})`)()
    fn(win, (s: string) => sent.push(JSON.parse(s)))
    fn(win, () => sent.push('twice')) // idempotent
    expect(sent[0]).toMatchObject({ kind: 'state', state: 'loading', origin: ORIGIN })

    win.console.error('boom', { a: 1 })
    win.console.warn('careful')
    win.dispatchEvent(new (win as any).ErrorEvent('error', { error: new Error('uncaught!'), message: 'uncaught!' }))
    const rejection = new (win as any).Event('unhandledrejection')
    rejection.reason = new Error('nope')
    win.dispatchEvent(rejection)
    win.history.pushState({}, '', '/next')

    const logs = sent.filter((m) => m.kind === 'log')
    expect(logs.map((l) => l.message)).toEqual([
      'boom {"a":1}',
      expect.stringContaining('Uncaught Error: uncaught!'),
      expect.stringContaining('Unhandled promise rejection: Error: nope'),
    ])
    expect(sent).not.toContain('twice')
    expect(sent.at(-1)).toMatchObject({ kind: 'state', state: 'navigated', url: `${ORIGIN}/next` })
  })
})
