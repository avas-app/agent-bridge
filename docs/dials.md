# Dials (beta)

Dials let you change a screen's values (a colour, a size, a theme token, a whole component) while the app runs, then write the ones you keep into the source. You tune in a web panel; a coding agent does the editing.

## Set up

In the dev bridge file, add `useDials` to the tools and return `<DialsOverlay />` from the bridge component:

```tsx
import { DialsOverlay, useDials } from '@avasapp/agent-bridge/dials'

export function AgentBridge() {
  useAgentBridge({
    tools: {
      ...useDials({
        theme: {
          tokens: () => ({ colors: themes.light }),
          labels: { colors: 'Colours', 'colors.accentSoft': 'Leaf tint' },
          file: 'src/theme.ts',
        },
      }),
    },
  })
  return <DialsOverlay />
}
```

- `tokens` returns your theme as an object. Token dials let you pick another token from the same group.
- `labels` gives tokens readable names in the panel, by path or group.
- `file` is where the theme lives, for the agent.
- `<DialsOverlay />` draws an outline around an element while you hover its dial.
- `agent-bridge init` adds `.agent-bridge/` to your `.gitignore`. Do not commit it.

Release builds compile all of this to nothing, like the rest of the bridge.

Optional: `react-native-view-shot` in the app makes the before and after crops fast (about 0.5 s). Without it, give the panel a screenshot command: `agent-bridge dials serve --screenshot-cmd 'agent-device screenshot {out}'`.

## Put dials in the code

```tsx
import { dial } from '@avasapp/agent-bridge/dials'

function PlantName({ plant }) {
  const g = { group: 'Plant card / Name' }
  const size = dial.number('name.size', 17, { min: 12, max: 24, label: 'Size', ...g })
  const color = dial.token('name.color', 'colors.text', c.text, { label: 'Colour', ...g })
  return <Text style={[styles.name, { color, fontSize: size }]}>{plant.name}</Text>
}
```

| Call | Returns |
| --- | --- |
| `dial.number(id, default, { min, max, step })` | a number |
| `dial.color(id, default)` | a colour string |
| `dial.enum(id, default, options)` | one of the options |
| `dial.boolean(id, default)` | a boolean |
| `dial.text(id, default)` | a string |
| `dial.token(id, tokenPath, fallback)` | the value of the picked theme token |
| `dial.variant(id, { name: Component }, default)` | the picked component |

- They are hooks: call them at the top of a component, not in loops or conditions.
- Put a dial in the component that renders the element. That component is what the panel outlines.
- `group: 'Section / Element'` sets the panel's left list and its sub-list.
- Put the alternatives for `dial.variant` in a separate file, so the others can be deleted on commit.

## The panel

```sh
agent-bridge dials serve              # http://localhost:<port>/?key=...
agent-bridge dials serve --tailscale  # reachable from your other machines
```

Open the link it prints. It stays the same across restarts; `--new-key` replaces it.

The panel reads the app through a bridge session. `serve` uses the project's running session, or starts one (`--metro`, `--device`, `--idle 8h`) and stops it with `--keep` when the panel stops; `--no-session` skips that.

A commit reaches the agent one of two ways. Without either, the panel marks it as queued and `dials list` shows it.

- `agent-bridge dials wait --json`, run in the background: it exits with the commit, which wakes an agent whose harness re-invokes it when a background task ends.
- `dials serve --exec '<cmd>'`: `serve` takes each commit and runs the command, with the commit as JSON on stdin and `DIALS_COMMIT_ID`, `DIALS_NOTE` and `DIALS_PROJECT` in its environment. The command should only tell the agent and return (it is stopped after 60 s); if it fails, the commit is marked failed with its error. The agent reads the commit with `agent-bridge dials show --json`.

`--exec` recipes:

```sh
# Paseo: queued into the agent's chat (--no-wait: plain send blocks until the agent finishes the message)
--exec 'paseo send --no-wait "$PASEO_AGENT_ID" "Dials commit $DIALS_COMMIT_ID: run agent-bridge dials show --json and apply it"'
# A terminal agent in tmux (Claude Code, Codex, OpenCode...): type into its own pane
--exec 'tmux send-keys -t "$TMUX_PANE" "Dials commit $DIALS_COMMIT_ID: run agent-bridge dials show --json and apply it" Enter'
# A fresh headless agent per commit; long jobs go in the background
--exec 'claude -p "Apply the dials commit from agent-bridge dials show --json" > .agent-bridge/commit.log 2>&1 &'
```

- Left: sections and elements, with the number of changed dials. Middle: the element's dials. Right: before and after crops of the element.
- Hover a dial and the element gets blue corner brackets on the device. They hide while the value changes and return 350 ms after the last change. Release the dial and the crop updates in about a second.
- Changes go to every connected device. Picks are saved in `.agent-bridge/dials.json` and come back after a reload or a new session.
- Variant dials show one thumbnail per option (Capture variants).
- Reset all, Copy values (to paste into a chat), and Commit.

## Outline colour

The brackets are `#3D7BFF` by default. The first one that is set wins:

1. The dial: `dial.number('card.radius', 16, { outline: { color: '#FF3EA5' } })` (any dial type).
2. The panel session: `agent-bridge dials serve --outline '#FF3EA5'`.
3. The app: `useDials({ theme, outline: { color: '#FF3EA5' } })`.
4. The default.

## Commit

Commit opens a list of the changed dials with the old and new value and the file and line. Tick the ones to keep, add a note, and send. The agent waiting on `dials wait` gets the request and the panel shows each step: sent, taken, writing, done or failed.

The agent writes the ticked values into source (a token dial becomes the token reference, not the hex; a variant dial keeps the chosen component and deletes the others), removes the dial calls, then runs `agent-bridge dials clear <ids>` and `agent-bridge dials check`. `check` lists any `dial.*` call still in source.

## Commands

```sh
agent-bridge dials list [--json]     # dials in the app and saved picks
agent-bridge dials resume            # put saved picks back after a reload
agent-bridge dials wait [--timeout <s>] [--json]   # block until Commit; exit 2 on timeout
agent-bridge dials commit-status <writing|done|failed|cancelled> [<commit id>] [--message <text>] [--reload]   # --reload also reloads the app through Metro
agent-bridge dials cancel                       # free a stuck commit; the panel has a Cancel button too
agent-bridge dials clear [ids...]    # drop saved picks (all with no ids)
agent-bridge dials check [--live]    # dial calls left in source
```

`dial.list`, `dial.set`, `dial.apply`, `dial.reset` and `dial.restore` also work as normal bridge tools.

## Security

- The panel is on `127.0.0.1` by default. `--tailscale` binds your Tailscale address; `--host` binds one you name.
- Every link carries a key, and the panel rejects requests without it. Anyone with the link can change dials on your devices and send a commit request, so treat it like a password and do not paste it in public places.
- The panel only changes values and sends requests. It does not edit files; the agent does.
- `.agent-bridge/` holds the saved picks and the key. Keep it out of git.
