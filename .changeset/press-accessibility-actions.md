---
"@avasapp/agent-bridge": minor
---

`screen.press` works on controls with no `onPress` that are screen-reader operable, such as swipe-to-confirm buttons: it calls `onAccessibilityAction` with `activate`, as VoiceOver and TalkBack do on a double tap, and the reply says `via: "accessibilityAction:activate"`. `screen.press(target, {action: "increment"})` sends any other action the element declares, and `screen.snapshot` lists them as `actions` and shows activatable controls as buttons.
