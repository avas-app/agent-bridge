// The screen tools' logic, given a way to read the fiber roots and the window
// size. tools/screen.ts wires it to React Native.
import type { Fiber } from '../find-text-core'
import {
  fillInput,
  isToggle,
  longPressFiberOf,
  pressElement,
  setControlValue,
  valueOf,
} from './actions'
import {
  collectScreen,
  focused,
  type Found,
  type Scrollable,
  type ScreenElement,
  type Window,
} from './elements'
import { findText, type FindTextOptions } from './find-text'
import {
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
  virtualLists,
  wait,
} from './scroll'
import { settle } from './settle'
import { describe, matchTarget, resolveTarget, type Target } from './targets'
import { type WaitForOptions, waitForTarget } from './wait-for'

export type { ScreenElement } from './elements'
export type { Target } from './targets'

export function createScreen(env: {
  roots: () => Fiber[]
  window: () => Window
}) {
  const collectAll = () => collectScreen(env.roots(), env.window())
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
  const PAGE_MS = 3000

  const scrollableAgain = (host: Fiber): Scrollable | undefined => {
    const node = host.stateNode
    return collectAll().scrollables.find(
      (s) => s.host === host || (node != null && s.host.stateNode === node),
    )
  }

  // Pages one list a viewport at a time (down from where it is, then from the
  // top back to where it was) until the target renders, a page limit or the deadline.
  const pageList = async (
    first: Scrollable,
    has: () => boolean,
    deadline: number,
  ): Promise<{ found: boolean; note: string }> => {
    const { host } = first
    const start = metricsOf(first)
    const name = () => {
      const el = collectAll().found.find((f) => f.host === host || f.host.stateNode === host.stateNode)
      return el ? describe(el.element) : 'the list'
    }
    if (!start) return { found: false, note: `${name()} has no readable scroll position` }
    const size = Math.max(
      1,
      ((isHorizontal(first) ? start.view?.width : start.view?.height) ?? 400) * 0.9,
    )
    let pages = 0
    let last: Metrics = start
    const go = async (offset: number) => {
      const now = scrollableAgain(host)
      if (!now) return false
      last = (await scrolled(now, () => (scrollToOffset(now, offset), offset))) ?? last
      pages++
      return has()
    }
    const room = () => pages < PAGE_LIMIT && Date.now() < deadline
    const done = (found: boolean) => ({
      found,
      note: `scroll:true paged ${name()} through ${pages} page(s), to offset ${Math.round(last.offset)} of ${last.max == null ? '?' : Math.round(last.max)}${found ? '' : ', without finding it'}`,
    })
    while (room()) {
      const now = scrollableAgain(host)
      const m = now && metricsOf(now)
      if (!m) break
      const next = Math.min(m.max ?? Infinity, m.offset + size)
      if (next - m.offset < 1) break
      if (await go(next)) return done(true)
    }
    if (pages < PAGE_LIMIT)
      for (let at = 0; at < start.offset && room(); at += size)
        if (await go(Math.min(at, start.offset))) return done(true)
    return done(false)
  }

  // For a target no rendered row matches: pages the virtualized lists on screen, looking for it.
  const pageFor = async (target: Target): Promise<{ found: boolean; note: string }> => {
    const has = () => matchTarget(collect().filter((f) => !f.hidden), target).length > 0
    const lists = virtualLists(collectAll().scrollables, env.window())
    if (!lists.length) return { found: false, note: '' }
    const deadline = Date.now() + PAGE_MS
    const notes: string[] = []
    for (const list of lists) {
      const result = await pageList(list, has, deadline)
      notes.push(result.note)
      if (result.found) return { found: true, note: notes.join('; ') }
    }
    return { found: false, note: notes.join('; ') }
  }

  // The element a target means, scrolled into view first when it is off
  // screen and `scroll` is set; a row a list has not rendered is paged to.
  const resolve = async (
    target: Target,
    prefer: (f: Found) => boolean,
    options: { index?: number; afterText?: boolean; scroll?: boolean },
  ): Promise<Found> => {
    const pick = () =>
      resolveTarget(collect(), target, prefer, { ...options, offscreen: options.scroll })
    let note = ''
    if (options.scroll && !matchTarget(collect(), target).length) {
      const paged = await pageFor(target)
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
      const found = collect()
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
      findText(collect(), text, options),

    async fill(
      target: Target,
      text: string,
      options: { submit?: boolean; type?: boolean; index?: number; scroll?: boolean } = {},
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
        scroll?: boolean
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
      options: { force?: boolean; index?: number; scroll?: boolean } = {},
    ): Promise<{ value: unknown; element: ScreenElement; warning?: string }> {
      const found = await resolve(target, (f) => !!f.change, options)
      const before = valueOf(found)
      setControlValue(found, value, options)
      await settle()
      const again = reread(found)
      const now = valueOf(again)
      const result = { value: now, element: again.element }
      // An uncontrolled control keeps no value prop to read back.
      if (before !== undefined && now !== value)
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
      waitForTarget(collect, target, options, reveal, () => pageFor(target)),
  }
}
