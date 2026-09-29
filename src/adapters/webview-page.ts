// The code that runs inside the page. Both functions are stringified and
// injected, so each must be self-contained: no imports, no reference to
// anything outside its own body. Everything they need arrives as arguments
// (`win` is the page's window, `post` sends a string to the app), which is also
// how the tests run them against a DOM.
//
// `pageMain` is the one fixed script behind every webview.* call. What the
// agent asked for is data in `argsJson`; none of it is evaluated.

/** Runs before the page's own scripts: page errors and navigation go to the app. */
export function bootMain(
  win: any, // oxlint-disable-line no-explicit-any -- the page's window
  post: (message: string) => void,
): void {
  if (win.__agentBridgeBoot) return
  win.__agentBridgeBoot = true
  const queue: string[] = []
  const send = (payload: Record<string, unknown>) => {
    const message = JSON.stringify({ __agentBridge: 1, ...payload })
    queue.push(message)
    try {
      // The native bridge object can arrive after this script runs.
      if (win.ReactNativeWebView) while (queue.length) post(queue.shift() as string)
    } catch {
      // Never break the page.
    }
  }
  const where = () => ({ url: String(win.location.href), origin: String(win.location.origin) })
  const state = (name: string) => send({ kind: 'state', state: name, ...where() })

  const text = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object' && 'message' in value) {
      const error = value as { name?: string; message?: string; stack?: string }
      return error.stack || `${error.name || 'Error'}: ${error.message}`
    }
    try {
      const json = JSON.stringify(value)
      return json === undefined ? String(value) : json
    } catch {
      return String(value)
    }
  }
  const report = (message: string) => send({ kind: 'log', level: 'error', message: message.slice(0, 2000) })

  const originalError = win.console.error
  win.console.error = function (...args: unknown[]) {
    report(args.map(text).join(' '))
    return originalError.apply(this, args)
  }
  win.addEventListener('error', (event: { error?: unknown; message?: string; filename?: string; lineno?: number }) => {
    if (event.error) report(`Uncaught ${text(event.error)}`)
    else report(`Uncaught ${event.message} (${event.filename}:${event.lineno})`)
  })
  win.addEventListener('unhandledrejection', (event: { reason?: unknown }) =>
    report(`Unhandled promise rejection: ${text(event.reason)}`),
  )

  state('loading')
  win.addEventListener('load', () => state('loaded'))
  win.addEventListener('popstate', () => state('navigated'))
  win.addEventListener('hashchange', () => state('navigated'))
  for (const method of ['pushState', 'replaceState']) {
    const original = win.history[method]
    win.history[method] = function (...args: unknown[]) {
      const result = original.apply(this, args)
      state('navigated')
      return result
    }
  }
}

/** One webview.* call: reads or drives the page, then replies over `post`. */
export function pageMain(
  win: any, // oxlint-disable-line no-explicit-any -- the page's window
  argsJson: string,
  post: (message: string) => void,
): void {
  type Info = {
    kind: string
    text?: string
    testID?: string
    label?: string
    placeholder?: string
    value?: string
    role?: string
    editable?: boolean
    disabled?: boolean
    checked?: boolean | 'mixed'
    selected?: boolean
    expanded?: boolean
    frame?: string
    note?: string
    rect: { x: number; y: number; width: number; height: number } | null
  }
  type Found = { info: Info; el: any; hasText: boolean } // oxlint-disable-line no-explicit-any
  type Target =
    | string
    | { testID?: string; label?: string; placeholder?: string; text?: string; role?: string; index?: number }

  const args = JSON.parse(argsJson) as {
    nonce: string
    op: 'snapshot' | 'press' | 'fill' | 'waitFor'
    allowed: string[]
    target?: Target
    text?: string
    options?: { force?: boolean; index?: number; submit?: boolean; gone?: boolean; timeoutMs?: number }
  }
  const origin = String(win.location.origin)
  const reply = (ok: boolean, payload: unknown) => {
    try {
      post(
        JSON.stringify(
          ok
            ? { __agentBridge: 1, kind: 'reply', nonce: args.nonce, origin, ok, result: payload }
            : { __agentBridge: 1, kind: 'reply', nonce: args.nonce, origin, ok, error: payload },
        ),
      )
    } catch {
      // Nothing to tell the app with.
    }
  }
  const fail = (error: unknown) =>
    reply(false, error instanceof Error ? error.message : String(error))

  // Nothing outside the allowed origins is read, not even to say what is there.
  if (!args.allowed.includes(origin)) {
    reply(false, `Origin ${origin} is not allowed (allowed: ${args.allowed.join(', ') || 'none'})`)
    return
  }

  const doc = win.document
  const TEST_ID = ['data-testid', 'data-test-id', 'data-cy']
  const SKIP = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']
  const INLINE = ['SPAN', 'B', 'I', 'EM', 'STRONG', 'SMALL', 'CODE', 'MARK', 'SUB', 'SUP', 'U', 'S', 'ABBR', 'CITE', 'Q', 'TIME']
  const BUTTON_ROLES = ['button', 'link', 'menuitem', 'tab', 'checkbox', 'switch', 'radio', 'option', 'menuitemcheckbox', 'menuitemradio']
  const INPUT_ROLES = ['textbox', 'searchbox', 'combobox']
  const PUSH_INPUTS = ['button', 'submit', 'reset', 'image']
  const TARGET_KEYS = ['testID', 'label', 'placeholder', 'text', 'role', 'index']

  const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim()
  const attr = (el: any, name: string) => el.getAttribute(name) as string | null // oxlint-disable-line no-explicit-any

  const isHidden = (el: any): boolean => { // oxlint-disable-line no-explicit-any
    if (el.hidden || attr(el, 'aria-hidden') === 'true') return true
    try {
      const style = win.getComputedStyle(el)
      return style.display === 'none' || style.visibility === 'hidden'
    } catch {
      return false
    }
  }

  const testIdOf = (el: any) => { // oxlint-disable-line no-explicit-any
    for (const name of TEST_ID) {
      const v = attr(el, name)
      if (v) return v
    }
    return undefined
  }

  const ownText = (el: any): boolean => // oxlint-disable-line no-explicit-any
    Array.from(el.childNodes as ArrayLike<any>).some((n) => n.nodeType === 3 && norm(n.nodeValue)) // oxlint-disable-line no-explicit-any

  const consumed = new WeakSet<object>()
  // An element's text: its own text nodes and the inline elements in it, which
  // are then part of it and not elements of their own.
  const textOf = (el: any, mark: boolean): string => { // oxlint-disable-line no-explicit-any
    const parts: string[] = []
    for (const n of Array.from(el.childNodes as ArrayLike<any>)) { // oxlint-disable-line no-explicit-any
      if (n.nodeType === 3) parts.push(n.nodeValue)
      else if (
        n.nodeType === 1 &&
        INLINE.includes(n.tagName) &&
        !testIdOf(n) &&
        !attr(n, 'aria-label') &&
        !attr(n, 'role') &&
        !isHidden(n)
      ) {
        if (mark) consumed.add(n)
        parts.push(textOf(n, mark))
      }
    }
    return norm(parts.join(' '))
  }

  const kindOf = (el: any): 'button' | 'input' | null => { // oxlint-disable-line no-explicit-any
    const tag = el.tagName as string
    const role = attr(el, 'role')
    if (tag === 'TEXTAREA' || tag === 'SELECT') return 'input'
    if (tag === 'INPUT') {
      const type = String(el.type || 'text').toLowerCase()
      if (type === 'hidden') return null
      if (PUSH_INPUTS.includes(type) || type === 'checkbox' || type === 'radio') return 'button'
      return 'input'
    }
    const editable = attr(el, 'contenteditable')
    if (editable === '' || editable === 'true') return 'input'
    if (role && INPUT_ROLES.includes(role)) return 'input'
    if (tag === 'BUTTON' || tag === 'SUMMARY' || (tag === 'A' && attr(el, 'href') !== null)) return 'button'
    if (role && BUTTON_ROLES.includes(role)) return 'button'
    return null
  }

  const roleOf = (el: any): string | undefined => { // oxlint-disable-line no-explicit-any
    const explicit = attr(el, 'role')
    if (explicit) return explicit
    const tag = el.tagName as string
    if (tag === 'A') return 'link'
    if (tag === 'BUTTON') return 'button'
    if (tag === 'SELECT') return 'combobox'
    if (tag === 'TEXTAREA') return 'textbox'
    if (tag === 'INPUT') {
      const type = String(el.type || 'text').toLowerCase()
      if (type === 'checkbox' || type === 'radio') return type
      if (PUSH_INPUTS.includes(type)) return 'button'
      return 'textbox'
    }
    return undefined
  }

  const labelOf = (el: any): string | undefined => { // oxlint-disable-line no-explicit-any
    const aria = attr(el, 'aria-label')
    if (aria) return aria
    const tag = el.tagName as string
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return undefined
    let text = ''
    try {
      text = norm(el.labels && el.labels[0] ? el.labels[0].textContent : '')
      if (!text && el.id) {
        const l = doc.querySelector(`label[for="${String(el.id).replace(/"/g, '\\"')}"]`)
        text = norm(l ? l.textContent : '')
      }
    } catch {
      // No label.
    }
    return text || undefined
  }

  const tri = (v: string | null): boolean | 'mixed' | undefined =>
    v === 'true' ? true : v === 'false' ? false : v === 'mixed' ? 'mixed' : undefined

  const describeEl = (el: any, kind: string, text: string | undefined, frame?: string): Info => { // oxlint-disable-line no-explicit-any
    const info: Info = { kind, rect: null }
    const testID = testIdOf(el)
    if (testID) info.testID = testID
    if (text) info.text = text
    const label = labelOf(el)
    if (label) info.label = label
    const placeholder = attr(el, 'placeholder')
    if (placeholder) info.placeholder = placeholder
    const role = kind === 'text' ? attr(el, 'role') || undefined : roleOf(el)
    if (role) info.role = role
    const tag = el.tagName as string
    const type = String(el.type || '').toLowerCase()
    if (kind === 'input') {
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        // Passwords are not echoed back.
        if (type === 'password') {
          if (el.value) info.value = '[hidden]'
        } else info.value = String(el.value)
        info.editable = !(el.readOnly || el.disabled)
      } else info.value = norm(el.textContent)
      if (info.editable === undefined) info.editable = true
    }
    if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) info.checked = !!el.checked
    else {
      const checked = tri(attr(el, 'aria-checked'))
      if (checked !== undefined) info.checked = checked
    }
    const selected = tri(attr(el, 'aria-selected'))
    if (selected !== undefined && selected !== 'mixed') info.selected = selected
    const expanded = tri(attr(el, 'aria-expanded'))
    if (expanded !== undefined && expanded !== 'mixed') info.expanded = expanded
    if (el.disabled === true || attr(el, 'aria-disabled') === 'true') info.disabled = true
    if (frame) info.frame = frame
    try {
      const r = el.getBoundingClientRect()
      info.rect = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
    } catch {
      // No layout.
    }
    return info
  }

  // Every element an agent can see or act on, in document order: open shadow
  // roots and same-origin iframes included.
  const collect = (): Found[] => {
    const out: Found[] = []
    const visit = (root: any, inButton: boolean, frame?: string) => { // oxlint-disable-line no-explicit-any
      for (const el of Array.from(root.children as ArrayLike<any>)) { // oxlint-disable-line no-explicit-any
        if (SKIP.includes(el.tagName) || isHidden(el)) continue
        const tag = el.tagName as string
        if (tag === 'IFRAME' || tag === 'FRAME') {
          let inner: any = null // oxlint-disable-line no-explicit-any
          try {
            // Null or a throw when the frame is cross-origin.
            inner = el.contentDocument
            if (inner) void inner.location.href
          } catch {
            inner = null
          }
          const name = testIdOf(el) || attr(el, 'name') || attr(el, 'id') || String(out.length)
          if (inner && inner.documentElement) visit(inner.documentElement, false, name)
          else {
            const info = describeEl(el, 'iframe', undefined, frame)
            info.note = 'iframe (cross-origin, not reachable)'
            out.push({ info, el, hasText: false })
          }
          continue
        }
        const kind = kindOf(el)
        const consumedInline = consumed.has(el)
        let pushed = false
        if (kind) {
          const text =
            kind === 'button'
              ? tag === 'INPUT'
                ? norm(el.value)
                : norm(el.textContent)
              : undefined
          out.push({ info: describeEl(el, kind, text || undefined, frame), el, hasText: !!text })
          pushed = true
        } else if (!inButton && !consumedInline && ownText(el)) {
          const text = textOf(el, true)
          if (text) {
            out.push({ info: describeEl(el, 'text', text, frame), el, hasText: true })
            pushed = true
          }
        }
        if (!pushed && !consumedInline && (testIdOf(el) || attr(el, 'aria-label'))) {
          out.push({ info: describeEl(el, 'view', undefined, frame), el, hasText: false })
        }
        const below = inButton || kind === 'button'
        if (el.shadowRoot) visit(el.shadowRoot, below, frame)
        visit(el, below, frame)
      }
    }
    visit(doc.documentElement, false)
    return out
  }

  const describe = (i: Info): string => {
    const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s)
    if (i.note) return i.note
    const bits = [i.checked !== undefined || i.selected !== undefined || i.expanded !== undefined ? i.role || i.kind : i.kind]
    if (i.testID) bits.push(`#${i.testID}`)
    if (i.text) bits.push(JSON.stringify(clip(i.text)))
    if (i.label && i.label !== i.text) bits.push(`label=${JSON.stringify(clip(i.label))}`)
    if (i.placeholder) bits.push(`placeholder=${JSON.stringify(clip(i.placeholder))}`)
    if (i.value !== undefined) bits.push(`value=${JSON.stringify(clip(i.value))}`)
    if (i.checked !== undefined) bits.push(i.checked === true ? 'checked' : i.checked === false ? 'unchecked' : 'mixed')
    if (i.selected !== undefined) bits.push(i.selected ? 'selected' : 'unselected')
    if (i.expanded !== undefined) bits.push(i.expanded ? 'expanded' : 'collapsed')
    if (i.disabled) bits.push('disabled')
    return bits.join(' ')
  }

  const showTarget = (t: Target) => JSON.stringify(t)

  // Same order as screen.*: testID, label, placeholder, text (exact, then
  // substring), then role. A view that is only an aria-label matches last.
  const match = (found: Found[], target: Target): Found[] => {
    if (typeof target !== 'string') {
      if (target === null || typeof target !== 'object' || Array.isArray(target))
        throw new Error(`A target is a string or an object with ${TARGET_KEYS.join(', ')}; got ${JSON.stringify(target)}`)
      const unknown = Object.keys(target).filter((k) => !TARGET_KEYS.includes(k))
      if (unknown.length)
        throw new Error(`Unknown target key ${unknown.map((k) => JSON.stringify(k)).join(', ')}. Valid keys: ${TARGET_KEYS.join(', ')}`)
    }
    const labelOnly = (f: Found) =>
      f.info.kind === 'view' && !f.info.testID && !f.info.text && !f.info.placeholder
    type Test = (i: Info) => boolean
    let tests: Test[]
    if (typeof target === 'string') {
      const lower = target.toLowerCase()
      tests = [
        (i) => i.testID === target,
        (i) => i.label === target,
        (i) => i.placeholder === target,
        (i) => i.text === target,
        (i) => !!i.text && i.text.includes(target),
        (i) => !!i.role && i.role.toLowerCase() === lower,
      ]
    } else {
      const { testID, label, placeholder, text, role } = target
      const fields: Test = (i) =>
        (testID === undefined || i.testID === testID) &&
        (label === undefined || i.label === label) &&
        (placeholder === undefined || i.placeholder === placeholder) &&
        (role === undefined || (!!i.role && i.role.toLowerCase() === role.toLowerCase()))
      tests =
        text === undefined
          ? [fields]
          : [(i) => fields(i) && i.text === text, (i) => fields(i) && !!i.text && i.text.includes(text)]
    }
    const usable = found.filter((f) => f.info.kind !== 'iframe')
    for (const pool of [usable.filter((f) => !labelOnly(f)), usable.filter(labelOnly)])
      for (const test of tests) {
        const matches = pool.filter((f) => test(f.info))
        if (matches.length) return matches
      }
    return []
  }

  const summary = (found: Found[], max = 15) => {
    const shown = found.slice(0, max).map((f) => describe(f.info))
    if (found.length > max) shown.push(`+${found.length - max} more`)
    return shown.length ? shown.join('; ') : 'nothing'
  }

  const resolve = (target: Target, prefer: (f: Found) => boolean, index: number | undefined): Found => {
    const found = collect()
    let matches = match(found, target)
    if (!matches.length)
      throw new Error(`Nothing in the page matches ${showTarget(target)}. On the page: ${summary(found)}`)
    const preferred = matches.filter(prefer)
    if (preferred.length) matches = preferred
    const at = index ?? (typeof target === 'object' ? target.index : undefined)
    if (at !== undefined) {
      const pick = matches[at]
      if (!pick) throw new Error(`${showTarget(target)} has ${matches.length} match(es); index ${at} is out of range`)
      return pick
    }
    if (matches.length > 1) {
      const list = matches.slice(0, 10).map((f, i) => `${i}: ${describe(f.info)}`).join('; ')
      throw new Error(
        `${showTarget(target)} matches ${matches.length} elements; pick one with an index, e.g. {"index":1} as the last argument, or use a narrower target. ${list}`,
      )
    }
    return matches[0] as Found
  }

  // Next animation frame, then 100 ms with no DOM mutations, capped at 2 s.
  const settle = (): Promise<{ ms: number; capped: boolean }> =>
    new Promise((resolveSettle) => {
      const t0 = Date.now()
      let finished = false
      let started = false
      let quiet: ReturnType<typeof setTimeout> | undefined
      let cap: ReturnType<typeof setTimeout> | undefined
      let observer: any = null // oxlint-disable-line no-explicit-any
      const done = (capped: boolean) => {
        if (finished) return
        finished = true
        clearTimeout(quiet)
        clearTimeout(cap)
        if (observer) observer.disconnect()
        resolveSettle({ ms: Date.now() - t0, capped })
      }
      cap = setTimeout(() => done(true), 2000)
      const begin = () => {
        if (started || finished) return
        started = true
        const wait = () => {
          clearTimeout(quiet)
          quiet = setTimeout(() => done(false), 100)
        }
        try {
          observer = new win.MutationObserver(wait)
          const options = { subtree: true, childList: true, attributes: true, characterData: true }
          observer.observe(doc, options)
          // Mutations inside open shadow roots don't reach the document's observer.
          for (const el of Array.from(doc.querySelectorAll('*') as ArrayLike<any>)) // oxlint-disable-line no-explicit-any
            if (el.shadowRoot) observer.observe(el.shadowRoot, options)
        } catch {
          // Quiet period only.
        }
        wait()
      }
      if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(begin)
      // A hidden page gets no frames.
      setTimeout(begin, 100)
    })

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  const click = (el: any) => { // oxlint-disable-line no-explicit-any
    try {
      if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' })
    } catch {
      // Not scrollable.
    }
    const init = { bubbles: true, cancelable: true, composed: true, view: win }
    if (typeof win.PointerEvent === 'function') el.dispatchEvent(new win.PointerEvent('pointerdown', init))
    el.dispatchEvent(new win.MouseEvent('mousedown', init))
    if (typeof el.focus === 'function') el.focus()
    if (typeof win.PointerEvent === 'function') el.dispatchEvent(new win.PointerEvent('pointerup', init))
    el.dispatchEvent(new win.MouseEvent('mouseup', init))
    el.click()
  }

  const setValue = (el: any, text: string) => { // oxlint-disable-line no-explicit-any
    const tag = el.tagName as string
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const proto = tag === 'INPUT' ? win.HTMLInputElement : tag === 'TEXTAREA' ? win.HTMLTextAreaElement : win.HTMLSelectElement
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
      // The prototype's setter, so React's and Vue's value tracking sees a change.
      if (setter) setter.call(el, text)
      else el.value = text
    } else el.textContent = text
  }

  const run = async (): Promise<unknown> => {
    const options = args.options || {}
    if (args.op === 'snapshot') {
      const elements = collect().map((f) => f.info)
      return { url: String(win.location.href), title: String(doc.title || ''), elements }
    }
    if (args.op === 'press') {
      const found = resolve(args.target as Target, (f) => f.info.kind === 'button', options.index)
      if (found.info.disabled && !options.force)
        throw new Error(`${describe(found.info)} is disabled; pass {"force":true} to press it anyway`)
      click(found.el)
      const settled = await settle()
      return { element: found.info, settled }
    }
    if (args.op === 'fill') {
      const found = resolve(args.target as Target, (f) => f.info.kind === 'input', options.index)
      if (found.info.kind !== 'input')
        throw new Error(`${describe(found.info)} is not an input; webview.press it instead`)
      if (found.info.editable === false) throw new Error(`${describe(found.info)} is not editable`)
      const text = String(args.text)
      const el = found.el
      if (typeof el.focus === 'function') el.focus()
      setValue(el, text)
      const isSelect = el.tagName === 'SELECT'
      if (!isSelect) el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      else el.dispatchEvent(new win.Event('input', { bubbles: true }))
      el.dispatchEvent(new win.Event('change', { bubbles: true }))
      if (options.submit) {
        const key = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }
        const down = new win.KeyboardEvent('keydown', key)
        el.dispatchEvent(down)
        el.dispatchEvent(new win.KeyboardEvent('keyup', key))
        if (!down.defaultPrevented && el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit()
      }
      const settled = await settle()
      const after = collect().find((f) => f.el === el)
      return { filled: text, element: (after || found).info, settled }
    }
    if (args.op === 'waitFor') {
      const timeout = options.timeoutMs ?? 5000
      const t0 = Date.now()
      for (;;) {
        const present = match(collect(), args.target as Target).length > 0
        if (present !== !!options.gone) break
        if (Date.now() - t0 >= timeout) {
          const found = collect()
          throw new Error(
            options.gone
              ? `${showTarget(args.target as Target)} is still on the page after ${timeout} ms. On the page: ${summary(found)}`
              : `Timed out after ${timeout} ms waiting for ${showTarget(args.target as Target)}. On the page: ${summary(found)}`,
          )
        }
        await sleep(50)
      }
      const settled = await settle()
      return { found: !options.gone, waitedMs: Date.now() - t0, settled }
    }
    throw new Error(`Unknown operation ${String(args.op)}`)
  }

  try {
    run().then((result) => reply(true, result), fail)
  } catch (error) {
    fail(error)
  }
}
