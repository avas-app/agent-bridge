# See and use the screen

```sh
npx agent-bridge call screen.snapshot                          # buttons, inputs, text on the focused screen (`hidden` counts what was skipped; {"all":true} lists everything)
npx agent-bridge call screen.findText "Payment"                 # text or accessibility label; {"labels":false} for text only
npx agent-bridge call screen.press '"add-plant"'               # by testID, label or text
npx agent-bridge call screen.press '[{"at":[350,60]}]'          # icon-only button: by point; {"index":1} picks among matches; {"force":true} presses disabled
npx agent-bridge call screen.press '["save-plant", {"scroll":true}]'   # scrolls an off-screen target into view first
npx agent-bridge call screen.scroll '"Notes"'                   # bring a target to the middle of its ScrollView/FlatList; {"toEnd":true}, {"by":400}, [{"toEnd":true},{"within":"list"}]
npx agent-bridge call screen.refresh                            # pull to refresh (the RefreshControl's onRefresh); then screen.waitFor the data
npx agent-bridge call screen.fill '["plant-name", "Fern"]'     # runs the input's handlers
npx agent-bridge call screen.waitFor '"Name is required"'      # {"gone": true} waits for it to go
```

`press` and `fill` return once the app has rendered the result, so the next
check sees it. `fill` skips the keyboard: autocorrect and native-only input
behaviour need one real typing step from agent-device.

A WebView shows in the snapshot as one element (`webview "checkout"`);
`screen.*` can't reach inside it. See [webview.md](webview.md).

## Screenshots

For a picture of the screen, call `screen.capture` (returns `{path}` of a PNG on
the device; `{"base64":true}` returns it inline when small). It works only if
the app already has `react-native-view-shot`. If it errors, take the screenshot
with agent-device, `xcrun simctl io booted screenshot <file>` or
`adb exec-out screencap -p > <file>` instead. Don't install anything or ask the
user to.
