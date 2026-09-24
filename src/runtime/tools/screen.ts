import { Dimensions } from 'react-native'

import { findTextInTree, fiberRoots } from '../find-text-core'
import type { Tools } from '../types'

const devToolsHook = () =>
  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ as
    | Parameters<typeof fiberRoots>[0]
    | undefined

export function screenTools(): Tools {
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
  }
}
