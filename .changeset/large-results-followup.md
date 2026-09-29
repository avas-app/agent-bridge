---
'@avasapp/agent-bridge': minor
---

`query.get` takes a last `{ pages: [from, to] }` to return only those pages of an infinite query (with `totalPages`), or `{ path: "pages.0.items" }` to return only the value there. `net.mocks` now cuts response `json` and `body` over ~2 KB like `net.log` does and marks the mock `truncated: true`; `{ full: true }` returns them whole (**behaviour change** for anything reading big mock bodies from `net.mocks`). A mock matched by a regex URL now lists the regex instead of `{}`. Fixes a CDP session dying when the app's JS thread was busy for over 1.5 s (for example while another client sent a multi-MB value): the health ping's timeout became an unhandled rejection in the session daemon.
