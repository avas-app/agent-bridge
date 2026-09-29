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
  mainScrollable,
  metricsOf,
  parseScroll,
  refreshHandler,
  scrollIntoView,
  scrollToEnd,
  scrollToOffset,
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

  // The same element after a re-render: host instances outlive their fibers.
  const reread = (found: Found): Found => {
    const node = found.host.stateNode
    const again = collect().find(
      (f) => f.host === found.host || (node != null && f.host.stateNode === node),
    )
    return again ?? found
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
    scrollFoundIntoView(found)
    await settle()
    found = reread(found)
    if (!found.onScreen)
      throw new Error(
        `${describe(found.element)} is still not on screen after scrolling`,
      )
    return found
  }

  const scrollableOf = (found: Found, what: string): Scrollable => {
    if (!found.scroller)
      throw new Error(`${describe(found.element)} ${what}`)
    return found.scroller
  }

  const scrollFoundIntoView = (found: Found) =>
    scrollIntoView(
      scrollableOf(found, 'is not inside a scrollable, so it can not be scrolled into view'),
      found,
    )

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
      const { found: all, scrollables } = collectAll()
      const pick = (t: Target) =>
        resolveTarget(all, t, undefined, { index: options.index, offscreen: true })
      const within = options.within
        ? scrollableOf(pick(options.within), 'is not a scrollable or inside one')
        : null
      const target = command.kind === 'to' ? pick(command.target) : null
      const scrollable =
        within ??
        (target
          ? scrollableOf(target, 'is not inside a scrollable')
          : mainScrollable(scrollables, env.window(), 'scroll'))
      if (target) scrollIntoView(scrollable, target)
      else if (command.kind === 'toEnd') scrollToEnd(scrollable)
      else if (command.kind === 'toStart') scrollToOffset(scrollable, 0)
      else if (command.kind === 'by') {
        const now = metricsOf(scrollable)
        if (!now) throw new Error('Can not read the scroll position, so can not scroll by a distance')
        scrollToOffset(
          scrollable,
          Math.max(0, Math.min(now.max ?? Infinity, now.offset + command.amount)),
        )
      }
      await settle()
      const after = metricsOf(scrollable)
      const result: {
        offset?: number
        max?: number
        element?: ScreenElement
        onScreen?: boolean
      } = {}
      if (after) {
        result.offset = Math.round(after.offset * 100) / 100
        if (after.max != null) result.max = Math.round(after.max * 100) / 100
      }
      if (target) {
        const again = reread(target)
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
