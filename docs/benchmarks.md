# Benchmarks

![The same checks with agent-device alone (22.4 s) and with agent-bridge (1.4 s): hide a tab, turn on dark mode, fill in a form, seed data, fake a live message and undo it all](../example/media/demo.gif)

The same checks on [the example app](../example) in Expo Go, both at real speed, all on one Mac:

- **agent-device alone** ([`demo-agent-device.mjs`](../example/flows/demo-agent-device.mjs)) taps and types through the UI, edits the fake backend and reloads to change the flag and the data, and asks the realtime server to push a message.
- **agent-device + agent-bridge** ([`demo.mjs`](../example/flows/demo.mjs)) makes each change with one call, then undoes them all with `bridge.restore`.

agent-device 0.21.15 won't press or fill most of this screen by selector on the iOS 27 simulator ([callstack/agent-device#2996](https://github.com/callstack/agent-device/issues/2996)), so the agent-device side looks up each element's frame and taps its centre. That adds one lookup per tap or fill.

| Call | Round trip |
| --- | --- |
| `bridge.ping` | 1–4 ms |
| `screen.findText`, `screen.waitFor` (already there) | 3–9 ms |
| `screen.fill`, `screen.press` | 20–120 ms, render included |
| `query.pin`, `store.call`, `router.navigate` | 11–55 ms, render included |
| 19 steps, no pauses | 1.3–1.5 s wall, 0.9 s of it waiting on the fake backend |

```
19 steps with agent-bridge:       1.4 s wall
same checks, agent-device alone:  22.4 s wall
same flow from another machine:   ~57 ms per call (network)
same screen check via a11y tree:  450–970 ms
```

## CLI overhead

Every CLI call is a new process. Measured on one Linux box (machine-dependent), that is roughly 90–100 ms with the bin and 280–320 ms through `npx` (about 55 and 250 ms with a session running), all of it startup rather than the bridge. For a timing check, or more than a handful of calls, write a flow file and use `agent-bridge run` (see [the CLI](cli.md#flows)).

Measured against the fake Metro used in the tests (Node 24, the built CLI, 30 calls): 665 ms per call for separate `call`s, 54 ms per call with a session running; a batch of 30 through a session took 80 ms in total (about 2.7 ms per call, one process start included), and a direct batch adds about 0.3 ms per call after its single 660 ms start.

## Transports

| | Expo dev-tools socket | CDP |
| --- | --- | --- |
| Round trip, local | 0.5 ms | 1.3 ms |
| Emoji in payloads | yes | yes (escaped for you) |
| Works with | Expo CLI | any RN app on Metro |

`connect()` tries Expo first and falls back to CDP.
