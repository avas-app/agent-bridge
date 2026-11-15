import { Dimensions } from 'react-native'

import { fiberRoots } from '../find-text-core'
import { createScreen, type SnapshotOptions, type Target } from '../screen'
import type { Tools } from '../types'
import { TOOL_DESCRIPTIONS } from './descriptions'

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
      description: TOOL_DESCRIPTIONS['screen.findText'],
      run: (text: string, options?: { exact?: boolean; labels?: boolean }) =>
        screen.findText(text, options),
    },
    'screen.snapshot': {
      description: TOOL_DESCRIPTIONS['screen.snapshot'],
      run: (options?: SnapshotOptions) =>
        options?.format === 'text' ? screen.snapshotText(options) : screen.snapshot(options),
    },
    'screen.fill': {
      description: TOOL_DESCRIPTIONS['screen.fill'],
      run: (
        target: Target,
        text: string,
        options?: { submit?: boolean; type?: boolean; index?: number; scroll?: boolean | { timeoutMs?: number } },
      ) =>
        screen.fill(target, text, options),
    },
    'screen.press': {
      description: TOOL_DESCRIPTIONS['screen.press'],
      run: (
        target: Target,
        options?: {
          force?: boolean
          index?: number
          scroll?: boolean | { timeoutMs?: number }
          action?: string
          long?: boolean
        },
      ) => screen.press(target, options),
    },
    'screen.setValue': {
      description: TOOL_DESCRIPTIONS['screen.setValue'],
      run: (
        target: Target,
        value: unknown,
        options?: { force?: boolean; index?: number; scroll?: boolean | { timeoutMs?: number } },
      ) => screen.setValue(target, value, options),
    },
    'screen.scroll': {
      description: TOOL_DESCRIPTIONS['screen.scroll'],
      run: (
        arg: Target | Record<string, unknown>,
        options?: { within?: Target; index?: number },
      ) => screen.scroll(arg, options),
    },
    'screen.refresh': {
      description: TOOL_DESCRIPTIONS['screen.refresh'],
      run: (target?: Target, options?: { index?: number }) =>
        screen.refresh(target, options),
    },
    'screen.waitFor': {
      description: TOOL_DESCRIPTIONS['screen.waitFor'],
      run: (target: Target, options?: { gone?: boolean; timeoutMs?: number; scroll?: boolean }) =>
        screen.waitFor(target, options),
    },
  }
}
