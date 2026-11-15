// The built-in tools' names and descriptions, with no react-native import so the MCP server can list them before an app connects.

/** Names a session reads and writes itself; hidden from the tool list because they carry raw values. */
export const INTERNAL_TOOLS = ['bridge.adopt']

/** Left out of the MCP list shown with no app connected: the server pings the app itself. */
export const UNLISTED_WITHOUT_APP = [...INTERNAL_TOOLS, 'bridge.ping']

export const TARGET_HELP =
  'target is a string (testID, label, placeholder or text) or an object that must match every key it sets: {testID, label, placeholder, text, at:[x,y], index}. Unknown keys are errors. {at:[x,y]} hits the smallest element covering that point, for icon-only buttons with no label. Several matches: add an index, either in the target or as a trailing {index:n} argument.'

export const TOOL_DESCRIPTIONS = {
  'app.reload':
    `Reload the app's JS (Expo's reloadAppAsync, else DevSettings.reload). Pending restores (store, query, mocks, pins, storage) are lost, and the reply names them: restore first. Returns before it reloads; a session waits for the new bridge and reports what was lost.`,
  'app.restore':
    `Undo what the app's own tools changed: runs the undos they registered with onRestore, newest first, once. Returns how many ran.`,
  'bridge.adopt':
    `Internal: a session hands back its journal after a reload.`,
  'bridge.logs':
    `Errors and warnings the app logged, newest last. Options: {level: "error"|"warn"|"all", limit, clear}.`,
  'bridge.pending':
    `What bridge.restore would undo right now, per area (store, query, net, app, ...): the value is true, or detail such as a store's snapshot against its current value. Empty when nothing is pending. Changes nothing.`,
  'bridge.ping':
    `Round-trip check. Returns the app clock.`,
  'bridge.restore':
    `Undo what the agent changed: runs every *.restore tool in name order, scenario.restore last, and returns each result or error.`,
  'bridge.tools':
    `Every tool this app exposes.`,
  'scenario.apply':
    `Apply a scenario: [name, options?]. Options must fit its schema (scenario.list). Returns what it returns. Applying an active one undoes it first. bridge.restore undoes it.`,
  'scenario.list':
    `Setups the app defines, e.g. a signed-in user: name, description, options (a JSON Schema), active.`,
  'scenario.restore':
    `Undo every active scenario, newest first. bridge.restore runs this after every other restorer.`,
  'screen.capture':
    `Screenshot the app as a PNG. Returns {path} of a file on the device. \`{base64:true}\` returns {base64} instead when small enough (else {path}). Only works if the app already has react-native-view-shot; otherwise errors and you use agent-device, simctl or adb.`,
  'screen.fill':
    `Type into an input, then wait for the render. ${TARGET_HELP} {submit:true} also submits. "" clears it. {type:true} types one character at a time, waiting for a render after each (for debounced or per-character inputs; "\\n" is the Enter key). An input with no value prop gets its native text set; if that cannot be done the reply has a warning.`,
  'screen.findText':
    `Find text on screen (substring, or exact with {exact:true}) and whether each match is on screen. Searches the same joined text screen.snapshot shows (nested Text concatenated) and accessibility labels; {labels:false} searches text only. Each match says which field matched; a miss lists near misses. Ignores screens the user can't reach (unfocused tabs and stack screens, under a modal); \`hidden\` counts matches there.`,
  'screen.press':
    `Press a button, then wait for the render. ${TARGET_HELP} Text with no handler of its own presses the nearest ancestor that has one, and the reply says via:"ancestor". Disabled elements are refused; {force:true} presses anyway, to see what the app does on tap. {scroll:true} scrolls an off-screen target into view first. With no onPress it sends the "activate" accessibility action, as a screen reader's double tap does (swipe-to-confirm buttons, sliders), and the reply says via:"accessibilityAction:activate". {action:"increment"} (or any name in the element's snapshot \`actions\`) sends that action instead. A Switch (native switch host or role switch, with onValueChange) is toggled with onValueChange(!value), not the row around it; reply via:"onValueChange". {long:true} long presses: onPressIn, onLongPress, onPressOut (never onPress); an error when there is no onLongPress, on the element or an ancestor. {scroll:true} also pages the largest vertical FlatList/SectionList/FlashList for a row it has not rendered yet (and scrolls back if it finds none; onEndReached may fire). A tap inside a react-native-gesture-handler GestureDetector cannot be pressed from here (its callbacks run on the UI thread): the error says so.`,
  'screen.refresh':
    `Pull to refresh: call the onRefresh of the RefreshControl of the scrollable holding a target (or the largest one with a RefreshControl on screen), then wait for the render. It does not wait for the data: follow with screen.waitFor.`,
  'screen.scroll':
    `Scroll the nearest ScrollView/FlatList/FlashList, then wait for the render. Takes a target (or {to: target}) to bring into the middle of its scrollable, {toEnd:true}, {toStart:true}, or {by: points} (negative scrolls back); the last argument may be {within: target, index} to name the scrollable (a target inside it, or its testID). Without a target it scrolls the largest scrollable on screen. Only rendered elements can be targeted: rows a FlatList has not rendered yet need {toEnd:true} or {by} first. Returns the offset and, for a target, whether it is now on screen. ${TARGET_HELP}`,
  'screen.setValue':
    `Set a Switch, Slider, Picker or SegmentedControl: calls its onValueChange (and a Slider's onSlidingComplete) with the value, waits for the render and reads the value back. A Switch takes true or false, a Slider a number within minimumValue and maximumValue (0 and 1 by default) and on its step (onSlidingStart, onValueChange, onSlidingComplete), a Picker one of its Picker.Item values, a SegmentedControl one of its values (a wrong type or value is an error that lists the options). The reply has \`value\` as the app now shows it, and a warning when that is not what was set (a controlled value the app refused). Disabled controls are refused; {force:true} sets anyway. {scroll:true} scrolls or pages the target into view first (pages the largest vertical list; onEndReached may fire). ${TARGET_HELP}`,
  'screen.snapshot':
    `Buttons, inputs, text, and testID or labelled views on screen, with rects and checked/selected/expanded state (a Switch's value is checked). \`actions\` lists the accessibility actions an element handles; one with "activate" and no onPress (a swipe-to-confirm) is a button screen.press can press. Only the focused screen: unfocused tabs and stack screens, content under an open modal, display:none and accessibility-hidden subtrees are left out, and \`hidden\` counts the elements skipped. {all:true} lists everything, marking off-screen (onScreen:false) and hidden (hidden:true) ones. A WebView registered with the react-native-webview adapter shows as one \`webview\` element with its name: use webview.* inside it. Options: {format:"json"|"text"} (the runtime default is JSON with rects; the CLI and the MCP server return the text form unless you pass {format:"json"}). Text is one line per element: kind (or role: switch, checkbox, tab), #testID, text, label, value, state, then \`readonly\`, \`actions=…\`, \`offscreen\`, \`hidden\`. Lines that repeat get \`index=N\` (the {index} of the target that names them); a line with no testID, text, label or placeholder gets \`@x,y\`, the point for {at:[x,y]}. JSON has rects, onScreen:false and hidden:true. {kinds:["button","input"]} keeps only those kinds (kinds are button, input, text, view, webview; a switch or tab is a button); {within: target} keeps only elements under that target in the tree (a target as for screen.press; with several matches pass {testID, index} inside it).`,
  'screen.waitFor':
    `Wait until a target is on screen, or gone with {gone:true}. Matches testID, label, placeholder, then the same joined text screen.snapshot shows. {scroll:true} also accepts a match rendered off screen and scrolls it into view, (it does not page lists for rows they have not rendered: wait for the list, then press/fill/setValue with {scroll:true}; not with gone). Default timeout 5000 ms; a timeout lists near misses.`,
} as const satisfies Record<string, string>

export type BuiltinToolName = keyof typeof TOOL_DESCRIPTIONS
