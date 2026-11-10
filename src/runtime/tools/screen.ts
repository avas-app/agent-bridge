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
        'Buttons, inputs, text, and testID or labelled views on screen, with rects and checked/selected/expanded state (a Switch\'s value is checked). `actions` lists the accessibility actions an element handles; one with "activate" and no onPress (a swipe-to-confirm) is a button screen.press can press. Only the focused screen: unfocused tabs and stack screens, content under an open modal, display:none and accessibility-hidden subtrees are left out, and `hidden` counts the elements skipped. {all:true} lists everything, marking off-screen (onScreen:false) and hidden (hidden:true) ones. A WebView registered with the react-native-webview adapter shows as one `webview` element with its name: use webview.* inside it.',
      run: (options?: { all?: boolean }) => screen.snapshot(options),
    },
    'screen.fill': {
      description:
        `Type into an input, then wait for the render. ${TARGET_HELP} {submit:true} also submits. "" clears it. {type:true} types one character at a time, waiting for a render after each (for debounced or per-character inputs; "\\n" is the Enter key). An input with no value prop gets its native text set; if that cannot be done the reply has a warning.`,
      run: (
        target: Target,
        text: string,
        options?: { submit?: boolean; type?: boolean; index?: number; scroll?: boolean },
      ) =>
        screen.fill(target, text, options),
    },
    'screen.press': {
      description:
        `Press a button, then wait for the render. ${TARGET_HELP} Text with no handler of its own presses the nearest ancestor that has one, and the reply says via:"ancestor". Disabled elements are refused; {force:true} presses anyway, to see what the app does on tap. {scroll:true} scrolls an off-screen target into view first. With no onPress it sends the "activate" accessibility action, as a screen reader's double tap does (swipe-to-confirm buttons, sliders), and the reply says via:"accessibilityAction:activate". {action:"increment"} (or any name in the element's snapshot \`actions\`) sends that action instead. A Switch (anything with onValueChange and a boolean value) is toggled with onValueChange(!value), not the row around it; reply via:"onValueChange". {long:true} long presses: onPressIn, onLongPress, onPressOut (never onPress); an error when there is no onLongPress, on the element or an ancestor. {scroll:true} also pages a FlatList/SectionList/FlashList for a row it has not rendered yet. A react-native-gesture-handler GestureDetector cannot be pressed from here (its callbacks run on the UI thread): the error says so.`,
      run: (
        target: Target,
        options?: {
          force?: boolean
          index?: number
          scroll?: boolean
          action?: string
          long?: boolean
        },
      ) => screen.press(target, options),
    },
    'screen.setValue': {
      description:
        `Set a Switch, Slider, Picker or SegmentedControl: calls its onValueChange (and a Slider's onSlidingComplete) with the value, waits for the render and reads the value back. A Switch takes true or false, a Slider a number within minimumValue and maximumValue, a Picker or SegmentedControl one of its items (a wrong type or value is an error that lists the options). The reply has \`value\` as the app now shows it, and a warning when that is not what was set (a controlled value the app refused). Disabled controls are refused; {force:true} sets anyway. {scroll:true} scrolls or pages the target into view first. ${TARGET_HELP}`,
      run: (
        target: Target,
        value: unknown,
        options?: { force?: boolean; index?: number; scroll?: boolean },
      ) => screen.setValue(target, value, options),
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
        'Wait until a target is on screen, or gone with {gone:true}. Matches testID, label, placeholder, then the same joined text screen.snapshot shows. {scroll:true} also accepts a match rendered off screen and scrolls it into view, and pages FlatList/SectionList/FlashList rows that are not rendered yet (not with gone). Default timeout 5000 ms; a timeout lists near misses.',
      run: (target: Target, options?: { gone?: boolean; timeoutMs?: number; scroll?: boolean }) =>
        screen.waitFor(target, options),
    },
  }
}
