// The screen tools' logic, given a way to read the fiber roots and the window
// size. tools/screen.ts wires it to React Native.
import { type Fiber, measureHost } from '../find-text-core'
import {
  fillInput,
  isSlider,
  isToggle,
  longPressFiberOf,
  pressElement,
  setControlValue,
  valueOf,
} from './actions'
import {
  collectScreen,
  UNMEASURED_ERROR,
  focused,
  type Found,
  type Scrollable,
  type ScreenElement,
  type Window,
} from './elements'
import { findText, type FindTextOptions } from './find-text'
import {
  awaitRows,
  awaitScroll,
  draggable,
  isHorizontal,
  layoutOf,
  mainScrollable,
  type Metrics,
  metricsOf,
  offsetFor,
  parseScroll,
  refreshHandler,
  scrollerFor,
  scrollToEnd,
  scrollToOffset,
  pagingList,
  wait,
} from './scroll'
import { settle } from './settle'
import { describe, indexOf, matchTarget, resolveTarget, type Target } from './targets'
import { type WaitForOptions, waitForTarget } from './wait-for'

export type { ScreenElement } from './elements'
export type { Target } from './targets'

export function createScreen(env: {
  roots: () => Fiber[]
  window: () => Window
}) {
  const collectLoose = () => collectScreen(env.roots(), env.window())
  const collectAll = () => {
    const all = collectLoose()
    if (all.unmeasured) throw new Error(UNMEASURED_ERROR)
    return all
  }
  const collect = () => collectAll().found

  // Right after a push the layout is still moving (the native header's height
  // arrives after the first frame): collect once the scrollables hold still.
  const collectSettled = async () => {
    let prev: string | null = null
    let same = 0
    for (let waited = 0; ; waited += 16) {
      const all = collectAll()
      const { ready, sig } = layoutOf(all.scrollables, env.window())
      same = sig === prev ? same + 1 : 0
      if (waited >= 320 || (ready ? same >= 3 : same >= 6)) return all
      prev = sig
      await wait(16)
    }
  }

  // The same element after a re-render: host instances outlive their fibers.
  const reread = (found: Found): Found => {
    const node = found.host.stateNode
    const again = collect().find(
      (f) => f.host === found.host || (node != null && f.host.stateNode === node),
    )
    return again ?? found
  }

  const scrollableOf = (found: Found, what: string): Scrollable => {
    if (!found.scroller)
      throw new Error(`${describe(found.element)} ${what}`)
    return found.scroller
  }

  // Runs a scroll, then waits for the render and for the native offset to land:
  // scrollTo works on the UI thread and reports back without a React commit.
  const scrolled = async (
    scrollable: Scrollable,
    act: () => number | undefined,
  ): Promise<Metrics | null> => {
    const before = metricsOf(scrollable)
    const want = act()
    await settle()
    return awaitScroll(scrollable, before?.offset, want ?? before?.max ?? undefined)
  }

  // Scrolls until the element is in view of every scrollable that can move it,
  // innermost first: a list that doesn't scroll (or scrolls the other way)
  // leaves it to the one around it.
  const bringIntoView = async (
    found: Found,
  ): Promise<{ found: Found; metrics: Metrics | null }> => {
    let current = found
    let metrics: Metrics | null = null
    for (let i = 0; i < 4; i++) {
      const plan = scrollerFor(current, env.window())
      if (!plan) break
      metrics = await scrolled(plan.scrollable, () => {
        scrollToOffset(plan.scrollable, plan.offset)
        return plan.offset
      })
      current = reread(current)
    }
    if (!metrics && current.scroller) metrics = metricsOf(current.scroller)
    return { found: current, metrics }
  }

  const reveal = async (found: Found): Promise<Found> => {
    const shown = (await bringIntoView(found)).found
    if (!shown.onScreen)
      throw new Error(
        `${describe(shown.element)} is not on screen and no scrollable around it can bring it into view`,
      )
    return shown
  }

  const PAGE_LIMIT = 40
  const PAGE_MS = 10_000

  // `scroll` is true, or {timeoutMs} to change the paging time budget.
  const pagingBudget = (scroll: boolean | { timeoutMs?: number } | undefined): number => {
    if (scroll === null || typeof scroll !== 'object') return PAGE_MS
    const bad = Object.keys(scroll).filter((k) => k !== 'timeoutMs')
    if (bad.length)
      throw new Error(`Unknown scroll option ${bad.map((k) => JSON.stringify(k)).join(', ')}. Valid: timeoutMs`)
    const ms = scroll.timeoutMs
    if (ms === undefined) return PAGE_MS
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0)
      throw new Error(`scroll.timeoutMs is a positive number of milliseconds; got ${JSON.stringify(ms)}`)
    return ms
  }

  const scrollableAgain = (host: Fiber): Scrollable | undefined => {
    const node = host.stateNode
    return collectAll().scrollables.find(
      (s) => s.host === host || (node != null && s.host.stateNode === node),
    )
  }

  // Whether the target has rendered (the `index`th match, when one is asked for).
  const rendered = (target: Target, index?: number) => () =>
    matchTarget(collect().filter((f) => !f.hidden), target).length > (indexOf(target) ?? index ?? 0)

  const nameOf = (host: Fiber) => {
    const el = collectAll().found.find((f) => f.host === host || f.host.stateNode === host.stateNode)
    return el ? describe(el.element) : 'the list'
  }

  // Pages one list from where it is, outward in both directions (the nearer end first),
  // until the target renders, both ends are reached, or the budget is spent. A list that
  // does not have it is scrolled back to where it was; one that does is left in place.
  const pageList = async (
    first: Scrollable,
    skipped: Scrollable[],
    has: () => boolean,
    budgetMs: number,
  ): Promise<{ found: boolean; note: string }> => {
    const { host } = first
    const name = nameOf(host)
    const first0 = metricsOf(first)
    if (!first0) return { found: false, note: `${name} has no readable scroll position` }
    const start: Metrics = first0
    const size = Math.max(1, ((isHorizontal(first) ? start.view?.width : start.view?.height) ?? 400) * 0.9)
    const deadline = performance.now() + budgetMs
    let pages = 0
    let lowest = start.offset
    let highest = start.offset
    let max = start.max
    let stop = 'both ends'
    const horizontal = isHorizontal(first)
    const node = host.stateNode
    let span: { top: number; bottom: number } | null = null
    const readRows = () => {
      const now = scrollableAgain(host)
      const metrics = now ? metricsOf(now) : null
      let rows = 0
      let top = Infinity
      let bottom = -Infinity
      for (const f of collectAll().found) {
        let inList = false
        for (let x = f.scroller; x; x = x.parent)
          if (x.host === host || (node != null && x.host.stateNode === node)) inList = true
        if (!inList) continue
        if (f.onScreen) rows++
        // Rendered rows as offsets along the scroll axis, off screen ones too.
        const box = metrics?.view && !metrics.inverted ? measureHost(f.host) : null
        if (!metrics?.view || !box) continue
        const at = (horizontal ? box.x - metrics.view.x : box.y - metrics.view.y) + metrics.offset
        top = Math.min(top, at)
        bottom = Math.max(bottom, at + (horizontal ? box.width : box.height))
      }
      span = top <= bottom ? { top, bottom } : null
      return { metrics, rows }
    }
    // Lands the offset, then looks for the target before waiting for rows to render.
    const go = async (offset: number) => {
      const now = scrollableAgain(host)
      if (!now) return false
      const before = metricsOf(now)
      scrollToOffset(now, offset)
      await awaitScroll(now, before?.offset, offset)
      pages++
      if (has()) return true
      const m = await awaitRows(readRows, has)
      if (m) {
        lowest = Math.min(lowest, m.offset)
        highest = Math.max(highest, m.offset)
        max = m.max
      }
      return has()
    }
    // One direction: true when the row rendered. A budget share ends it early.
    const sweep = async (dir: 1 | -1, until: number, limit: number): Promise<boolean> => {
      const from = pages
      while (true) {
        if (pages - from >= limit || performance.now() >= until) {
          stop = pages >= PAGE_LIMIT ? `the ${PAGE_LIMIT}-page limit` : `the ${budgetMs} ms budget`
          return false
        }
        const m = readRows().metrics
        if (!m) return false
        // Step to just past the rendered rows (a virtualized list renders several
        // viewports), so each page brings new rows; at least one viewport.
        const viewSize = size / 0.9
        const reach = span as { top: number; bottom: number } | null
        const want =
          dir === 1
            ? Math.max(m.offset + size, reach ? reach.bottom : -Infinity)
            : Math.min(m.offset - size, reach ? reach.top - viewSize : Infinity)
        const next = dir === 1 ? Math.min(m.max ?? Infinity, want) : Math.max(0, want)
        if (Math.abs(next - m.offset) < 1) {
          // At the end: rows measured late (or onEndReached) may have grown the content.
          const grown = await awaitRows(readRows, has, 400)
          if (has()) return true
          if (dir === 1 && grown && (grown.max ?? 0) - m.offset >= 1) continue
          return false
        }
        if (await go(next)) return true
      }
    }
    let found = false
    try {
      const downFirst = start.max == null || start.max - start.offset <= start.offset
      const order: (1 | -1)[] = downFirst ? [1, -1] : [-1, 1]
      const now = performance.now()
      for (const [i, dir] of order.entries()) {
        // The first direction keeps half unless the other has no room (a list at an end).
        const otherRoom = dir === -1 ? start.max == null || start.max - start.offset >= 1 : start.offset >= 1
        const half = i === 0 && otherRoom
        const share = half ? now + budgetMs / 2 : deadline
        const limit = half ? PAGE_LIMIT / 2 : PAGE_LIMIT - pages
        if (dir === -1 && start.offset < 1) continue
        // The second direction starts back at the start offset.
        if (i === 1 && pages) await go(start.offset)
        if (await sweep(dir, share, limit)) return (found = true), done()
      }
    } finally {
      if (!found) {
        const now = scrollableAgain(host)
        if (now) {
          await scrolled(now, () => (scrollToOffset(now, start.offset), start.offset))
          await settle()
        }
      }
    }
    return done()
    function done() {
      const where = `up to offset ${Math.round(lowest)} and down to offset ${Math.round(highest)} of ${max == null ? '?' : Math.round(max)}`
      const left = skipped.length ? `. Not paged: ${skipped.map((s) => nameOf(s.host)).join(', ')}` : ''
      return {
        found,
        note: found
          ? ''
          : `{scroll:true} paged ${name} ${pages} page(s), ${where}, without rendering a match, then scrolled back to offset ${Math.round(start.offset)}. Stopped at: ${stop}${left}`,
      }
    }
  }

  // For a target no rendered row matches: pages the main virtualized list on screen, looking for it.
  const pageFor = async (has: () => boolean, budgetMs: number): Promise<{ found: boolean; note: string }> => {
    const { list, skipped } = pagingList(collectAll().scrollables, env.window())
    if (!list)
      return { found: false, note: '{scroll:true} found no FlatList, SectionList or FlashList on screen to page' }
    return pageList(list, skipped, has, budgetMs)
  }

  // The element a target means, scrolled into view first when it is off
  // screen and `scroll` is set; a row a list has not rendered is paged to.
  const resolve = async (
    target: Target,
    prefer: (f: Found) => boolean,
    options: { index?: number; afterText?: boolean; scroll?: boolean | { timeoutMs?: number } },
  ): Promise<Found> => {
    const pick = () =>
      resolveTarget(collect(), target, prefer, { ...options, offscreen: !!options.scroll })
    let note = ''
    if (options.scroll && typeof target === 'object' && target.at !== undefined)
      throw new Error(
        '{at:[x,y]} is a point on the screen and can\'t be scrolled to; drop {scroll:true} or target by text or testID',
      )
    const has = rendered(target, options.index)
    if (options.scroll && !has()) {
      const paged = await pageFor(has, pagingBudget(options.scroll))
      note = paged.note
      if (!paged.found) {
        try {
          return await settleOn(pick())
        } catch (error) {
          throw note ? new Error(`${(error as Error).message}. ${note}`) : error
        }
      }
    }
    return settleOn(pick())
  }

  const settleOn = async (found: Found) => (found.onScreen ? found : reveal(found))

  return {
    snapshot(options: { all?: boolean } = {}): { elements: ScreenElement[]; hidden?: number } {
      const found = options.all ? collectLoose().found : collect()
      if (options.all)
        return {
          elements: found.map((f) => ({
            ...f.element,
            onScreen: f.onScreen,
            ...(f.hidden && { hidden: true }),
          })),
        }
      const shown = focused(found)
      const elements = shown.filter((f) => f.onScreen).map((f) => f.element)
      const hidden = found.length - shown.length
      return hidden ? { elements, hidden } : { elements }
    },

    findText: (text: string, options?: FindTextOptions) =>
      findText(collectLoose().found, text, options),

    async fill(
      target: Target,
      text: string,
      options: { submit?: boolean; type?: boolean; index?: number; scroll?: boolean | { timeoutMs?: number } } = {},
    ): Promise<{ filled: string; element: ScreenElement; warning?: string }> {
      const found = await resolve(target, (f) => !!f.input, {
        index: options.index,
        afterText: true,
        scroll: options.scroll,
      })
      const { filled, native } = await fillInput(found, String(text), {
        ...options,
        between: async () => void (await settle()),
        again: reread,
      })
      await settle()
      const element = reread(found).element
      // An uncontrolled input has no value prop to read back: report what was written natively.
      if (native === true) return { filled, element: { ...element, value: filled } }
      if (native === false)
        return {
          filled,
          element,
          warning:
            'the input has no value prop and its native text could not be set from here, so the field may not show the text',
        }
      return { filled, element }
    },

    async press(
      target: Target,
      options: {
        force?: boolean
        index?: number
        scroll?: boolean | { timeoutMs?: number }
        action?: string
        long?: boolean
      } = {},
    ): Promise<ScreenElement & { via?: string }> {
      const { action } = options
      if (action !== undefined && typeof action !== 'string')
        throw new Error(`"action" must be an accessibility action name; got ${JSON.stringify(action)}`)
      const found = await resolve(
        target,
        (f) =>
          options.long
            ? !!longPressFiberOf(f)
            : action === undefined
              ? !!f.press || f.element.kind === 'button' || isToggle(f)
              : !!f.element.actions?.includes(action),
        options,
      )
      const via = pressElement(found, options)
      await settle()
      // Only a press that skipped onPress says so, to keep the usual reply unchanged.
      return via === 'onPress' ? found.element : { ...found.element, via }
    },

    /** Sets a Switch, Slider, Picker or SegmentedControl through its onValueChange, and reads the value back. */
    async setValue(
      target: Target,
      value: unknown,
      options: { force?: boolean; index?: number; scroll?: boolean | { timeoutMs?: number } } = {},
    ): Promise<{ value: unknown; element: ScreenElement; warning?: string }> {
      const found = await resolve(target, (f) => !!f.change, options)
      const before = valueOf(found)
      setControlValue(found, value, options)
      await settle()
      const again = reread(found)
      const now = valueOf(again)
      const result = { value: now, element: again.element }
      // A Slider's `value` is often only its start value, and an uncontrolled control keeps none to read back.
      const same = typeof now === 'number' && typeof value === 'number' ? Math.abs(now - value) < 1e-6 : now === value
      if (before !== undefined && !same && !(found.change && isSlider(found.change)))
        return {
          ...result,
          warning: `the control still shows ${JSON.stringify(now)}; the app did not apply ${JSON.stringify(value)}`,
        }
      return result
    },

    /**
     * Scrolls the nearest scrollable of a target (or `within`, or the main one
     * on screen) to the target, to either end, or by a distance in points.
     */
    async scroll(
      arg: Target | Record<string, unknown>,
      options: { within?: Target; index?: number } = {},
    ): Promise<{ offset?: number; max?: number; element?: ScreenElement; onScreen?: boolean }> {
      const command = parseScroll(arg)
      const { found: all, scrollables } = await collectSettled()
      // `index` picks among the target's matches; a `within` target carries its own.
      const named = options.within
        ? scrollableOf(
            resolveTarget(all, options.within, undefined, { offscreen: true }),
            'is not a scrollable or inside one',
          )
        : null
      // A list with scrollEnabled={false} leaves the scrolling to the one around it.
      const within = named && draggable(named)
      if (named && !within)
        throw new Error(
          `${describe(resolveTarget(all, options.within as Target, undefined, { offscreen: true }).element)} can't be scrolled (scrollEnabled is false, or it is on a hidden screen) and no scrollable around it can`,
        )
      const target =
        command.kind === 'to'
          ? resolveTarget(all, command.target, undefined, {
              index: options.index,
              offscreen: true,
            })
          : null
      let metrics: Metrics | null
      let again: Found | null = null
      if (target && !within) {
        scrollableOf(target, 'is not inside a scrollable')
        ;({ found: again, metrics } = await bringIntoView(target))
      } else if (target && within) {
        const offset = offsetFor(within, target, env.window())
        metrics =
          offset === null
            ? metricsOf(within)
            : await scrolled(within, () => (scrollToOffset(within, offset), offset))
        again = reread(target)
      } else {
        const scrollable = within ?? mainScrollable(scrollables, env.window(), 'scroll')
        metrics = await scrolled(scrollable, () => {
          if (command.kind === 'toEnd') {
            scrollToEnd(scrollable)
            return metricsOf(scrollable)?.max ?? undefined
          }
          if (command.kind === 'toStart') {
            scrollToOffset(scrollable, 0)
            return 0
          }
          const now = metricsOf(scrollable)
          if (!now)
            throw new Error('Can not read the scroll position, so can not scroll by a distance')
          const next = Math.max(
            0,
            Math.min(now.max ?? Infinity, now.offset + (command as { amount: number }).amount),
          )
          scrollToOffset(scrollable, next)
          return next
        })
      }
      const result: {
        offset?: number
        max?: number
        element?: ScreenElement
        onScreen?: boolean
      } = {}
      if (metrics) {
        result.offset = Math.round(metrics.offset * 100) / 100
        if (metrics.max != null) result.max = Math.round(metrics.max * 100) / 100
      }
      if (again) {
        result.element = again.element
        result.onScreen = again.onScreen
      }
      return result
    },

    /** Calls the `onRefresh` of a scrollable's RefreshControl, as a pull would. */
    async refresh(
      target?: Target,
      options: { index?: number } = {},
    ): Promise<{ refreshed: true }> {
      const { found: all, scrollables } = collectAll()
      const scrollable = target
        ? scrollableOf(
            resolveTarget(all, target, undefined, {
              index: options.index,
              offscreen: true,
            }),
            'is not a scrollable or inside one',
          )
        : mainScrollable(scrollables, env.window(), 'refresh')
      const onRefresh = refreshHandler(scrollable)
      if (!onRefresh) throw new Error('That scrollable has no RefreshControl (or onRefresh prop)')
      onRefresh()
      await settle()
      return { refreshed: true }
    },

    waitFor: (target: Target, options?: WaitForOptions) =>
      waitForTarget(collect, target, options, reveal),
  }
}
