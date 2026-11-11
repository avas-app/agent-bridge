---
"@avasapp/agent-bridge": minor
---

New adapter for apps on `@react-navigation/native` without expo-router: `navTools(navigationRef)` from `@avasapp/agent-bridge/react-navigation`. It adds `nav.navigate`, `nav.push`, `nav.replace`, `nav.back`, `nav.popToTop` and `nav.current`. Each navigation tool waits for the new screen and returns the route the app ended on (`name`, `params`, `path`, `stack`, `canGoBack`), warns when it is not the screen asked for, and throws on an unknown route name. Pass `getStateFromPath` and `linking` to let `nav.navigate` take a path like `/post/7`. The tools are named `nav.*` so they do not clash with `router.*`. `init` now writes a commented `navTools(navigationRef)` line for these apps, replacing the old sample tools.
