---
'@avasapp/agent-bridge': patch
---

On Android, a ScrollView or FlatList with a RefreshControl showed up twice in `screen.snapshot` (the refresh layout and the ScrollView inside it both carry the testID), so `{within: '<testID>'}` and other targets naming it failed as ambiguous. It is one element now. A FlatList no longer reports `value: "[object Object]"` (VirtualizedList's context value).
