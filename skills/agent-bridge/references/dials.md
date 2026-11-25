# Dials: tune a screen with the user, then write it into source

Dials make a value in a component changeable live from a web panel. The user tunes; you wire it, show the panel, and write the result.

## 1. Wire once

In the dev bridge file: `...useDials({ theme: { tokens, labels, file } })` in `tools`, and `return <DialsOverlay />` from the bridge component (import both from `@avasapp/agent-bridge/dials`).

- `tokens: () => ({ colors: themes.light })` returns the theme as an object. Give tokens readable `labels` (`{ colors: 'Colours', 'colors.accentSoft': 'Leaf tint' }`) and keep them once set.
- `react-native-view-shot` in the app makes the crops fast (about 0.5 s). Without it: `agent-bridge dials serve --screenshot-cmd '<cmd with {out}>'`.

## 2. Wrap

Add `dial.*` calls in the component that renders the element. That component is what gets outlined, so use the smallest one that renders it, and split a component if needed.

```tsx
const size = dial.number('name.size', 17, { min: 12, max: 24, label: 'Size', group: 'Plant card / Name' })
const color = dial.token('name.color', 'colors.text', c.text, { label: 'Colour', group: 'Plant card / Name' })
const Card = dial.variant('plant.card', { roomy: RoomyCard, compact: CompactCard }, 'roomy')
```

- Types: `number`, `color`, `enum`, `boolean`, `text`, `token`, `variant`.
- They are hooks: top of the component, never in loops or conditions.
- Values in `StyleSheet.create` move inline while tuned (`style={[styles.name, { fontSize: size }]}`).
- Groups are `'Section / Element'`.
- `dial.variant` is for whole components (named with a capital letter; anything else is treated as a plain value). Put the alternatives in a separate file.

## 3. Present

```sh
agent-bridge dials serve --tailscale    # or without the flag for local
agent-bridge dials wait --json          # run in the background; returns when the user presses Commit
```

Run both in the background; `serve` starts a session if none is running. Without `wait`, a Commit just sits queued, so the step is not done until both run. If your harness can take a message from a shell command (`paseo send "$PASEO_AGENT_ID" ...`, `tmux send-keys -t "$TMUX_PANE" ...`), pass it as `serve --exec '<cmd>'` instead of running `wait`, then read the commit with `dials show --json`. Give the user the URL `serve` prints. It is the same across restarts; `--new-key` replaces it.

## 4. While the user tunes

Do not edit the files being tuned, unless they ask. Adding or removing a dial or a blocking bug is also fine.

Outline colour (default `#3D7BFF`): per dial `{ outline: { color } }` in the meta, then `dials serve --outline <color>`, then `useDials({ outline: { color } })`, then the default; the first one set wins.

## 5. Commit

When `dials wait` returns a request:

```sh
agent-bridge dials commit-status writing <id>   # id from the request
# write each ticked value into source, remove the dial calls
agent-bridge dials clear <ids>
agent-bridge dials check                # must not list the ids you committed
agent-bridge dials commit-status done <id> --message '<what changed>'   # or: failed <id> --message '<why>'
```

- `done` reloads the app through Metro: removing dial calls changes the hook count, which Fast Refresh can't follow ("Rendered fewer hooks"). Pass `--metro <host:port>` if no session is running; `--no-reload` skips it.
- Read `note` in the request. If `revertOthers` is true, put the unticked dials back to their original value in source.
- Token dials: write the token reference (`colors.accentSoft`), not the hex.
- Variant dial: keep the chosen component, delete the others and the variants file.
- Remove the `dial.*` calls and move inline values back into `StyleSheet.create`.
- Restart `dials wait` if the user may commit again.
- A request stays in flight until done, failed or cancelled; the panel refuses a new one meanwhile. `agent-bridge dials cancel` clears a stuck one.

Never commit `.agent-bridge/`: it holds the saved picks and the panel key.

Other commands: `dials list`, `dials resume` (put saved picks back), `dials check --live`. Tools: `dial.list`, `dial.set`, `dial.apply`, `dial.reset`, `dial.restore`. More: [docs/dials.md](../../../docs/dials.md).
