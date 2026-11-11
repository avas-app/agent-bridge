# Built-in tools and restore

## Every app gets

- `screen.snapshot`: buttons, inputs, text, and `testID` or labelled views on the focused screen, with positions and `checked` / `selected` / `expanded` state. Unfocused tabs and stack screens, content under an open modal, `display: none` and accessibility-hidden subtrees are left out (`hidden` counts them); `{all:true}` lists everything (a native-stack `formSheet` with an undimmed detent still hides the screen beneath it). Press, fill, `waitFor` and `findText` see the same focused screen.
- `screen.fill`, `screen.press`: call an input's or button's own handlers, found by `testID`, label, placeholder or text, and return once React has rendered the result. A target is a string or `{testID, label, placeholder, text, at:[x,y], index}`; unknown keys are errors. `{at:[x,y]}` hits the smallest element covering that point (icon-only buttons), and `index` picks among several matches, in the target or as a trailing `{index}` argument. `screen.press(target, {force:true})` presses a disabled element on purpose, and `{scroll:true}` scrolls an off-screen target into view first. A control with no `onPress` that declares an `activate` accessibility action (a swipe-to-confirm, anything made screen-reader operable) is pressed by calling its `onAccessibilityAction` with `activate`, as VoiceOver and TalkBack do on a double tap; the reply then says `via: "accessibilityAction:activate"`. `{action:"increment"}` sends any other action the element declares. The snapshot lists them as `actions`. A press that reaches a handler on an ancestor (the element has none of its own, e.g. loose text) says `via: "ancestor"` (or `"ancestor:accessibilityAction:activate"`). A pressable that wraps an input, or two or more other controls (buttons, switches, `activate` actions; the pressable's own wrapper components and inline `<Text onPress>` links don't count), is a layout wrapper, such as a tap-to-dismiss-keyboard screen or a modal backdrop: it does not own the text under it, so that text shows as text rather than one big button. `screen.fill` calls `onFocus`, `onChangeText`, `onChange`, then `onSubmitEditing` (with `{submit:true}`), `onEndEditing` and `onBlur`. An input with no `value` prop (or `value: undefined`) also gets its native text set, and the reply's `element.value` is what was written; if it could not be written the reply has a `warning` and keeps the value the app shows. `""` clears it, and `{type:true}` types one character at a time (`onKeyPress` and `onChangeText` for each, `"\n"` as the `Enter` key), waiting for a render after each so debounced search and OTP inputs see every step.
- `screen.scroll`, `screen.refresh`: scroll the nearest `ScrollView` / `FlatList` / `FlashList` to a target, to `{toEnd:true}` / `{toStart:true}`, or `{by: points}` (`{within: target}` names the scrollable), and pull to refresh by calling the `RefreshControl`'s `onRefresh`. Both return once React has rendered; follow a refresh with `screen.waitFor` for the data.
- `screen.waitFor`, `screen.findText`: wait for, or check, text or a target on screen. Both match the same joined text the snapshot shows; `findText` also matches accessibility labels (`{labels:false}` for text only) and lists near misses when nothing matches. `waitFor` takes `{gone:true}` to wait for a target to leave, `{timeoutMs}` (default 5000), and `{scroll:true}` to accept a match rendered off screen, such as content below the fold of a `ScrollView`, and scroll it into view; `gone` and `scroll` together are refused.
- `bridge.restore`: undo what the agent changed, by running every `*.restore` tool. With the network and TanStack Query adapters it also resets queries whose data came from a `net.mock` (`query.restore` returns `mockedCleared`; `net.unmock` and `net.restore` do it too), in any order. A query counts as mocked when a request its query function started synchronously was answered by an agent mock. A request started later (after an `await`, behind an async interceptor such as axios's async auth-token hook, or in a retry) can't be tied to a query, so a mock answering it marks every query fetching at that moment. Those get reset too, even if real, and one that is observed refetches once. Use synchronous interceptors to keep it exact. Mocks from app code or scenarios aren't tracked. Infinite queries stay marked until reset, since a real page fetch leaves the mocked pages.
- `bridge.pending`: what `bridge.restore` would undo right now, per area. Stores show each changed key's snapshot against its current value (redacted, long values cut). Changes nothing.
- `screen.capture`: screenshot as a PNG; returns `{path}` of a file on the device, or `{base64}` with `{base64:true}` when small. It works only if your app already has `react-native-view-shot` (the bridge never adds it). The package is loaded with a `require` inside `try/catch`, which Metro treats as optional, so apps without it bundle fine and get an error naming agent-device, `xcrun simctl io` and `adb exec-out screencap -p` as alternatives.
- `app.reload`: reload the app's JS (Expo's `reloadAppAsync` when the app has Expo SDK 51+; otherwise `DevSettings.reload`). Pending restores are lost, except MMKV and persisted-store changes a session keeps (see [What restore will undo](#what-restore-will-undo)); a session waits for the new bridge before the next call.
- `bridge.logs`, `bridge.ping`, `bridge.tools`.

Custom tools that change the screen can `await settle()` (from `@avasapp/agent-bridge`) so the next check sees the render.

Errors come back on their own: each reply carries what the app logged with `console.error`, threw or left unhandled since the previous reply, tagged with the call it happened during or after.

## Expose the hooks your agents keep needing

Real apps have queues, timers, retry loops and caches that are not in a store or a query. Give the agent a tool for each one, next to the built-in ones. It is an ordinary function, JSON in and out, and it exists only in dev builds:

```tsx
useAgentBridge({
  tools: {
    // Run the queued work now instead of waiting for its timer.
    'queue.flush': () => uploadQueue.flush(),
    'realtime.reconnect': () => realtime.reconnect(),
  },
})
```

When a tool changes something `bridge.restore` doesn't know about, register how to put it back with `onRestore(fn, label?)`. `bridge.restore` runs the undos once, newest first (`app.restore`), and `bridge.pending` lists their labels under `app` until then. A failing undo is reported and the rest still run.

```tsx
import { onRestore } from '@avasapp/agent-bridge'

tools: {
  // Swap a host handler for a fake; restore puts the real one back.
  'host.mockMethod': (name: string, result: unknown) => {
    const original = host[name]
    host[name] = async () => result
    onRestore(() => { host[name] = original }, `host.${name}`)
    return { mocked: name }
  },
}
```

Call `onRestore` each time the tool changes something, so mocking twice restores both, in reverse. Register inside the tool's `run`: an `onRestore` called elsewhere (say at startup) counts as pending straight away and runs on the next restore, whether or not an agent touched anything. `bridge.restore` runs `*.restore` tools in area order, so app undos (`app.restore`) run before `net`, `query` and `store`, and newest first within `app`; `scenario.restore` always goes last. If an undo needs a store or mock still in place, register it from a scenario's `onUndo` instead. There is deliberately no `app.eval`: code the agent can run is a tool you wrote, and it can be undone.

## What restore will undo

A store is snapshotted on the first `store.set` or `store.call` since the last restore. Changes made before that, such as tapping the UI, are not in the snapshot, so a value that was already wrong is what restore puts back. Check first with `bridge.pending`, and if the current value is the one you want, `store.commit <store>` drops the snapshot: restore leaves the store alone, and the next write snapshots again. `store.set <store> {}` snapshots without changing anything, to arm it before you drive the UI.

**Across a reload.** The undo state is app memory, so `app.reload` or a crash normally loses it. A session also keeps a journal of what sits in storage: `mmkv.set` and `mmkv.delete` of string values (numbers and booleans are not journaled), and changes to a zustand store made with `persist` (only the persisted part, as `partialize` picks it, compared and put back key by key: a key you did not change is never written, so a boot-time write like `launchCount` stays). A key whose value is not plain JSON (a `Set`, `Map`, `Date`, class instance), or that `partialize` renames or derives, is not kept: the reload notice says `not kept across reload: store:key`. An MMKV entry records the instance's `id` when the instance has one (MMKV v2 and v3); an entry for a different `id` is left alone and named, and a `mmkv.delete` whose key is simply absent after the reload is reported as already back to the original unless the same `id` is confirmed (v4 instances have no `id`, so a deleted key is not re-armed there). The journal lives in the session's memory only, holds raw values, and is never logged or written to a file; if the session itself dies it is gone. After the reload the session hands it back and the new runtime re-arms the undo without changing anything, so the app boots on your fake token and `bridge.restore` still puts the original back. A key whose value is no longer what you wrote (the app changed it) is left alone and reported, and an area that is not ready (a persisted store that has not hydrated, an MMKV instance the app does not register) is tried again on the next two calls, then reported once as `could not re-arm after the reload: ...` and dropped. Entries that are not the shape the session saved are ignored and named. The journal travels on the reply to the call that changed it, only to the session that started with the app: the runtime keeps the first per-session key it is sent and refuses `bridge.adopt` and journal data to anything else, so `agent-bridge call` and `connect()` cannot read it. The key crosses the same local socket as the calls themselves, so on a shared Metro, treat anything that can see your calls as able to see it. A write whose reply is lost to a reload cannot be recovered: the next call says its undo may be lost. When a store and a non-persisted area were both changed, `kept N undos` can hide that the non-persisted one is lost; check `bridge.pending` after a reload. Stores without `persist`, queries, mocks and `onRestore` callbacks are lost, as before. Without a session (one-off CLI calls) nothing is kept.

`session stop --dry-run` prints what `bridge.pending` reports without restoring or stopping. `session stop --keep` warns when something is still pending, because a later `bridge.restore` will undo it.
