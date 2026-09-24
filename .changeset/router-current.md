---
'@avasapp/agent-bridge': minor
---

- `router.current` returns the current route (pathname, href, params, segments, name, canGoBack). Pass `routerTools(router, { navigation: useNavigationContainerRef() })`; the navigation tools then return once the route has changed.
- `routerTools` accepts expo-router's `router` with typed routes on.
