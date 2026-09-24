import { Dimensions } from 'react-native'

import { findTextInTree, fiberRoots } from '../find-text-core'
import { createScreen, type Target } from '../screen'
import type { Tools } from '../types'

const devToolsHook = () =>
  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ as
    | Parameters<typeof fiberRoots>[0]
    | undefined

export function screenTools(): Tools {
  const screen = createScreen({
    roots: () => fiberRoots(devToolsHook()),
    window: () => Dimensions.get('window'),
  })
  return {
    'screen.findText': {
      description:
        'Find rendered text (substring, or exact with {exact:true}) and whether it is on screen. Ignores inactive tabs and screens.',
      run: (text: string, options?: { exact?: boolean }) =>
        findTextInTree(
          fiberRoots(devToolsHook()),
          text,
          Dimensions.get('window'),
          options,
        ),
    },
    'screen.snapshot': {
      description:
        'Buttons, inputs, text and testID views on screen, with rects. {all:true} adds off-screen ones.',
      run: (options?: { all?: boolean }) => screen.snapshot(options),
    },
    'screen.fill': {
      description:
        'Type into an input by testID, label, placeholder or text, then wait for the render. {submit:true} also submits.',
      run: (target: Target, text: string, options?: { submit?: boolean }) =>
        screen.fill(target, text, options),
    },
    'screen.press': {
      description:
        'Press a button by testID, label or text, then wait for the render.',
      run: (target: Target) => screen.press(target),
    },
    'screen.waitFor': {
      description:
        'Wait until a target is on screen, or gone with {gone:true}. Default timeout 5000 ms.',
      run: (target: Target, options?: { gone?: boolean; timeoutMs?: number }) =>
        screen.waitFor(target, options),
    },
  }
}
