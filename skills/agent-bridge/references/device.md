# Device events (`device.*`)

Only there if the app added `deviceTools`; check `bridge.tools`.

```sh
npx @avasapp/agent-bridge call device.openUrl '"myapp://orders/5"'   # deep link into the running app; returns the route when the app passes navigation
npx @avasapp/agent-bridge call device.appState '"background"'        # then '"active"'
npx @avasapp/agent-bridge call device.offline true                   # fetch, XHR and NetInfo; false goes back
npx @avasapp/agent-bridge call device.notification '[{"title":"Hi","data":{"id":5}},{"tapped":true}]'
npx @avasapp/agent-bridge call device.setTime '"2030-01-02T03:04:05Z"'   # only with time: true
npx @avasapp/agent-bridge call device.restore
```

- `device.openUrl` is for a running app. A cold start reads its URL before the bridge can fake it: open that link with agent-device.
- `device.offline` fails mocked requests too. Metro stays reachable.
- Without `{tapped:true}` a notification calls the received listeners (app open); with it, the response listeners.
- The clock moves `Date.now()` and `new Date()` only; timers do not move. After `device.setTime`, call `device.appState '"active"'` so query caches recheck staleness.
- `bridge.pending` lists what is set under `device`, and `bridge.restore` undoes it.
