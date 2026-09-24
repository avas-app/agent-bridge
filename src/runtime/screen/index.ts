// The screen tools' logic, given a way to read the fiber roots and the window
// size. tools/screen.ts wires it to React Native.
import type { Fiber } from '../find-text-core'
import { fillInput, pressElement } from './actions'
import {
  collectElements,
  type Found,
  type ScreenElement,
  type Window,
} from './elements'
import { settle } from './settle'
import { resolveTarget, type Target } from './targets'
import { type WaitForOptions, waitForTarget } from './wait-for'

export type { ScreenElement } from './elements'
export type { Target } from './targets'

export function createScreen(env: {
  roots: () => Fiber[]
  window: () => Window
}) {
  const collect = () => collectElements(env.roots(), env.window())

  // The same element after a re-render: host instances outlive their fibers.
  const refresh = (found: Found): ScreenElement => {
    const node = found.host.stateNode
    const again = collect().find(
      (f) => f.host === found.host || (node != null && f.host.stateNode === node),
    )
    return (again ?? found).element
  }

  return {
    snapshot(options: { all?: boolean } = {}): { elements: ScreenElement[] } {
      const found = collect()
      if (!options.all)
        return { elements: found.filter((f) => f.onScreen).map((f) => f.element) }
      return {
        elements: found.map((f) => ({ ...f.element, onScreen: f.onScreen })),
      }
    },

    async fill(
      target: Target,
      text: string,
      options: { submit?: boolean } = {},
    ): Promise<{ filled: string; element: ScreenElement }> {
      const found = resolveTarget(collect(), target, (f) => !!f.input)
      const filled = fillInput(found, String(text), options)
      await settle()
      return { filled, element: refresh(found) }
    },

    async press(target: Target): Promise<ScreenElement> {
      const found = resolveTarget(collect(), target, (f) => !!f.press)
      pressElement(found)
      await settle()
      return found.element
    },

    waitFor: (target: Target, options?: WaitForOptions) =>
      waitForTarget(collect, target, options),
  }
}
