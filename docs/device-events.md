# Device events

Fake what comes from outside the JS: an incoming deep link, the app going to the background, going offline, a push notification and (opt in) the clock. Nothing is on unless you add the tools:

```tsx
import { deviceTools } from '@avasapp/agent-bridge/device'
import NetInfo from '@react-native-community/netinfo'
import * as Notifications from 'expo-notifications'
import { useNavigationContainerRef } from 'expo-router'

// in AgentBridge: tools: { ...deviceTools({ NetInfo, Notifications, navigation, time: true }) }
```

Every option is optional. Linking, AppState and the event emitter come from `react-native`. `deviceTools` is a no-op in release builds.

| Tool | What it does |
| --- | --- |
| `device.openUrl "myapp://orders/5"` | Emits the `url` event to every Linking listener (expo-router and expo-linking included, even ones added before the bridge started) and makes `Linking.getInitialURL()` return it. Returns `{url, listeners}`, plus `route` when you pass `navigation`. |
| `device.appState "background"` | Fires every AppState change listener and makes `AppState.currentState` report `active`, `background` or `inactive`. |
| `device.offline true` | Every `fetch` and XHR fails like no network, mocks included (Metro stays reachable). With `NetInfo` passed in, its listeners, `NetInfo.fetch` and `useNetInfo` see offline too. |
| `device.notification '[{"title":"Hi","data":{"id":5}}]'` | Calls expo-notifications' received listeners. `[{...}, {"tapped": true}]` calls the response listeners with the default action instead. Needs `Notifications`. |
| `device.setTime '"2030-01-02T03:04:05Z"'` or `'{"offsetMs": 86400000}'` | Shifts `Date.now()` and `new Date()`. Needs `time: true`. |
| `device.restore` | Undoes all of it. `bridge.restore` runs it, and `bridge.pending` lists what is set under `device`. |

Limits:

- `device.openUrl` reaches a running app. expo-router reads its cold-start URL once at launch, so the faked `getInitialURL` only helps code that asks later; to test a cold start, open the link with agent-device.
- While `device.appState` is set, real native app-state events still reach listeners, but `currentState` keeps the fake until restore.
- `device.offline` asks NetInfo for a refresh when it is undone. The NetInfo part emits NetInfo's own change event, so check it against your NetInfo version.
- `device.notification` emits on expo-notifications' native emitter, so it reaches `useLastNotificationResponse` and listeners added earlier. It does not fake `getLastNotificationResponseAsync` or the permission prompt.
- The clock shifts only `Date.now()` and `new Date()` with no arguments. Timers and `performance.now` keep real time, code that read the time earlier keeps its value, and the bridge's own log timestamps follow the fake clock. React Query only rechecks staleness on its next trigger, so follow `device.setTime` with `device.appState "active"`.
