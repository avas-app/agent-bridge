# See and use the screen

```sh
npx @avasapp/agent-bridge call screen.snapshot                          # buttons, inputs, text on the focused screen (`hidden` counts what was skipped; {"all":true} lists everything)
npx @avasapp/agent-bridge call screen.findText "Payment"                 # text or accessibility label; {"labels":false} for text only
npx @avasapp/agent-bridge call screen.press '"add-plant"'               # by testID, label or text
npx @avasapp/agent-bridge call screen.press '[{"at":[350,60]}]'          # icon-only button: by point; {"index":1} picks among matches; {"force":true} presses disabled
npx @avasapp/agent-bridge call screen.press '["save-plant", {"scroll":true}]'   # scrolls an off-screen target into view first
npx @avasapp/agent-bridge call screen.press '"Swipe to confirm"'        # no onPress: sends the "activate" accessibility action
npx @avasapp/agent-bridge call screen.press '["Volume", {"action":"increment"}]'   # any action in the element's snapshot `actions`
npx @avasapp/agent-bridge call screen.scroll '"Notes"'                   # bring a target to the middle of its ScrollView/FlatList; {"toEnd":true}, {"by":400}, [{"toEnd":true},{"within":"list"}]
npx @avasapp/agent-bridge call screen.refresh                            # pull to refresh (the RefreshControl's onRefresh); then screen.waitFor the data
npx @avasapp/agent-bridge call screen.fill '["plant-name", "Fern"]'     # runs the input's handlers
npx @avasapp/agent-bridge call screen.waitFor '"Name is required"'      # {"gone": true} waits for it to go
npx @avasapp/agent-bridge call screen.waitFor '["Section title", {"scroll":true}]'   # also below the fold: scrolls it into view (not with gone)
```

`press` and `fill` return once the app has rendered the result, so the next
check sees it. `fill` skips the keyboard: autocorrect and native-only input
behaviour need one real typing step from agent-device.

A swipe-to-confirm or slider with no `onPress` shows as a button (or a view)
with `actions` in the snapshot. `press` calls its `onAccessibilityAction` with
`activate`, as a screen reader's double tap does, and the reply says
`via: "accessibilityAction:activate"`. A gesture control with no `actions`
needs a real swipe from agent-device.

A WebView shows in the snapshot as one element (`webview "checkout"`);
`screen.*` can't reach inside it. See [webview.md](webview.md).

## Screenshots

For a picture of the screen, call `screen.capture` (returns `{path}` of a PNG on
the device; `{"base64":true}` returns it inline when small). It works only if
the app already has `react-native-view-shot`. If it errors, take the screenshot
with agent-device, `xcrun simctl io booted screenshot <file>` or
`adb exec-out screencap -p > <file>` instead. Don't install anything or ask the
user to.
