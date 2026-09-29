import { Dimensions } from 'react-native'

import { fiberRoots } from '../find-text-core'
import { createScreen, type Target } from '../screen'
import type { Tools } from '../types'

const devToolsHook = () =>
  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ as
    | Parameters<typeof fiberRoots>[0]
    | undefined

const TARGET_HELP =
  'target is a string (testID, label, placeholder or text) or an object that must match every key it sets: {testID, label, placeholder, text, at:[x,y], index}. Unknown keys are errors. {at:[x,y]} hits the smallest element covering that point, for icon-only buttons with no label. Several matches: add an index, either in the target or as a trailing {index:n} argument.'

export function screenTools(): Tools {
  const screen = createScreen({
    roots: () => fiberRoots(devToolsHook()),
    window: () => Dimensions.get('window'),
  })
  return {
    'screen.findText': {
      description:
        "Find text on screen (substring, or exact with {exact:true}) and whether each match is on screen. Searches the same joined text screen.snapshot shows (nested Text concatenated) and accessibility labels; {labels:false} searches text only. Each match says which field matched; a miss lists near misses. Ignores screens the user can't reach (unfocused tabs and stack screens, under a modal); `hidden` counts matches there.",
      run: (text: string, options?: { exact?: boolean; labels?: boolean }) =>
        screen.findText(text, options),
    },
    'screen.snapshot': {
      description:
        'Buttons, inputs, text, and testID or labelled views on screen, with rects and checked/selected/expanded state (a Switch\'s value is checked). Only the focused screen: unfocused tabs and stack screens, content under an open modal, display:none and accessibility-hidden subtrees are left out, and `hidden` counts the elements skipped. {all:true} lists everything, marking off-screen (onScreen:false) and hidden (hidden:true) ones.',
      run: (options?: { all?: boolean }) => screen.snapshot(options),
    },
    'screen.fill': {
      description:
        `Type into an input, then wait for the render. ${TARGET_HELP} {submit:true} also submits.`,
      run: (
        target: Target,
        text: string,
        options?: { submit?: boolean; index?: number; scroll?: boolean },
      ) =>
        screen.fill(target, text, options),
    },
    'screen.press': {
      description:
        `Press a button, then wait for the render. ${TARGET_HELP} Disabled elements are refused; {force:true} presses anyway, to see what the app does on tap. {scroll:true} scrolls an off-screen target into view first.`,
      run: (target: Target, options?: { force?: boolean; index?: number; scroll?: boolean }) =>
        screen.press(target, options),
    },
    'screen.scroll': {
      description:
        `Scroll the nearest ScrollView/FlatList/FlashList, then wait for the render. Takes a target (or {to: target}) to bring into the middle of its scrollable, {toEnd:true}, {toStart:true}, or {by: points} (negative scrolls back); the last argument may be {within: target, index} to name the scrollable (a target inside it, or its testID). Without a target it scrolls the largest scrollable on screen. Only rendered elements can be targeted: rows a FlatList has not rendered yet need {toEnd:true} or {by} first. Returns the offset and, for a target, whether it is now on screen. ${TARGET_HELP}`,
      run: (
        arg: Target | Record<string, unknown>,
        options?: { within?: Target; index?: number },
      ) => screen.scroll(arg, options),
    },
    'screen.refresh': {
      description:
        'Pull to refresh: call the onRefresh of the RefreshControl of the scrollable holding a target (or the largest one with a RefreshControl on screen), then wait for the render. It does not wait for the data: follow with screen.waitFor.',
      run: (target?: Target, options?: { index?: number }) =>
        screen.refresh(target, options),
    },
    'screen.waitFor': {
      description:
        'Wait until a target is on screen, or gone with {gone:true}. Matches testID, label, placeholder, then the same joined text screen.snapshot shows. Default timeout 5000 ms; a timeout lists near misses.',
      run: (target: Target, options?: { gone?: boolean; timeoutMs?: number }) =>
        screen.waitFor(target, options),
    },
  }
}
