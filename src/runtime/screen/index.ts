// The screen tools' logic, given a way to read the fiber roots and the window
// size. tools/screen.ts wires it to React Native.
import type { Fiber } from '../find-text-core'
import { fillInput, pressElement } from './actions'
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
  wait,
} from './scroll'
import { settle } from './settle'
import { describe, resolveTarget, type Target } from './targets'
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

  // The element a target means, scrolled into view first when it is off
  // screen and `scroll` is set.
  const resolve = async (
    target: Target,
    prefer: (f: Found) => boolean,
    options: { index?: number; afterText?: boolean; scroll?: boolean },
  ): Promise<Found> => {
    let found = resolveTarget(collect(), target, prefer, {
      ...options,
      offscreen: options.scroll,
    })
    if (found.onScreen) return found
    found = (await bringIntoView(found)).found
    if (!found.onScreen)
      throw new Error(
        `${describe(found.element)} is not on screen and no scrollable around it can bring it into view`,
      )
    return found
  }

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
      options: { submit?: boolean; index?: number; scroll?: boolean } = {},
    ): Promise<{ filled: string; element: ScreenElement }> {
      const found = await resolve(target, (f) => !!f.input, {
        index: options.index,
        afterText: true,
        scroll: options.scroll,
      })
      const filled = fillInput(found, String(text), options)
      await settle()
      return { filled, element: reread(found).element }
    },

    async press(
      target: Target,
      options: { force?: boolean; index?: number; scroll?: boolean } = {},
    ): Promise<ScreenElement> {
      const found = await resolve(target, (f) => !!f.press, options)
      pressElement(found, options)
      await settle()
      return found.element
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
      waitForTarget(collect, target, options),
  }
}
