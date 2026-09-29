---
'@avasapp/agent-bridge': minor
---

New `router.dismiss` and `router.dismissAll` tools close route-based modals. `router.back`'s description now says it only pops the navigator and leaves modals and sheets the app renders itself open; the README recommends registering a `modal.close` tool for those. `RouterLike` gains optional `dismiss`, `dismissAll` and `canDismiss`; a router without them makes the two tools throw a clear error.
