// The demo without agent-bridge, done with Argent's tools: the same checks as
// demo.flow.mjs and demo-agent-device.mjs. It taps and types through the UI,
// edits the fake backend and reloads to change flags and data, and asks the
// realtime server to push a message. Every Argent call is one `argent run`
// process, like agent-device's CLI.
//
//   npm i @swmansion/argent && npx argent server start --port 3011 --no-auth --detach
//   npm run realtime                                  # in another terminal
//   UDID=<simulator udid> METRO=localhost:8081 node flows/demo-argent.mjs
//
// Argent finds simulators outside the default device set only if you add
// theirs: `argent config set ios.additionalDeviceSets '["<path>"]' --scope project`.
// Run it from the folder you installed Argent in, on the Metro machine: it
// edits src/dev/fake-backend.ts and puts it back at the end.
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
const UDID = process.env.UDID
if (!UDID) throw new Error('set UDID to the simulator id from `argent run list-devices`')
const METRO = process.env.METRO ?? 'localhost:8081'
const REALTIME = process.env.REALTIME_URL ?? 'http://localhost:8138'
const ARGENT = process.env.ARGENT ?? 'argent'
const BACKEND = new URL('../src/dev/fake-backend.ts', import.meta.url)

// Same edge cases as demo.flow.mjs seeds with query.pin.
const plants = `const plants: Plant[] = [
  { id: 's1', name: 'Orchid', species: 'Phalaenopsis', emoji: '🥀', waterInDays: -3 },
  { id: 's2', name: 'Fern with a name long enough to wrap', species: 'Nephrolepis', emoji: '🌿', waterInDays: 0 },
  { id: 's3', name: 'Cactus', species: 'Echinopsis', emoji: '🌵', waterInDays: 60 },
]`

const argent = async (tool, flags = {}) => {
  const args = ['run', tool, '--json']
  for (const [key, value] of Object.entries(flags))
    args.push(typeof value === 'object' ? `--${key}-json` : `--${key}`, typeof value === 'object' ? JSON.stringify(value) : String(value))
  const { stdout } = await run(ARGENT, args, { maxBuffer: 16 * 1024 * 1024 })
  return JSON.parse(stdout)
}
const device = (tool, flags) => argent(tool, { udid: UDID, ...flags })
// debugger-reload-metro reloads over CDP, which leaves Expo Go 57 with "Cannot find
// native module 'ExpoAsset'", and opening the project URL again doesn't reload. So
// shake for the dev menu and tap Reload; the native menu isn't in the accessibility
// tree, so its position comes from a screenshot.
const reload = async () => {
  await device('shake')
  await new Promise((resolve) => setTimeout(resolve, 900))
  await device('gesture-tap', { x: 0.27, y: 0.566 })
}

// `describe` lists every element with its label, id and a normalized frame
// (the theme options are labelled "<icon>, Dark").
const elements = async () => {
  const { description } = await device('describe')
  return description.split('\n').flatMap((line) => {
    const frame = line.match(/\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)\s*$/)
    if (!frame) return []
    const [, x, y, w, h] = frame
    return [{
      label: line.match(/^\s+AX\w+ "(.*?)"(?: |$)/)?.[1] ?? '',
      id: line.match(/ id="(.*?)"/)?.[1] ?? '',
      x: +x + +w / 2,
      y: +y + +h / 2,
    }]
  })
}
// Taps don't wait for the screen to change, so look again for a few seconds
// before giving up, the way an agent re-reads the tree after a tap.
const find = async (query) => {
  for (let attempt = 0; ; attempt++) {
    const found = (await elements()).find((el) =>
      query.id ? el.id === query.id : query.prefix ? el.label.startsWith(query.prefix) : el.label === query.label || el.label.endsWith(`, ${query.label}`),
    )
    if (found) return found
    if (attempt === 9) throw new Error(`no element for ${JSON.stringify(query)}; on screen: ${(await elements()).map((el) => el.label || el.id).filter(Boolean).slice(0, 40).join(' | ')}`)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}
const tap = async (query) => {
  const { x, y } = await find(query)
  await device('gesture-tap', { x, y })
}
const fill = async (query, text) => {
  await tap(query)
  await device('fill', { text })
}
const waitFor = (text, timeoutMs = 5000) =>
  device('await-ui-element', { condition: 'exists', selector: { text }, timeoutMs, pollIntervalMs: 200 }).then(async (result) => {
    if (!result.success) throw new Error(`"${text}" never showed up; on screen: ${(await elements()).map((el) => el.label || el.id).filter(Boolean).slice(0, 12).join(' | ')}`)
  })
// Tab labels carry their position ("Inbox, tab, 4 of 5"), which moves when
// the Shop tab goes, so find them by prefix.
const tab = (name) => tap({ prefix: `${name}, tab` })

const timings = []
const t0 = performance.now()
const step = async (label, action) => {
  const start = performance.now()
  try {
    await action()
  } catch (error) {
    throw new Error(`${label}: ${error.stderr?.trim() || error.message}`)
  }
  const ms = performance.now() - start
  timings.push({ label, atMs: Math.round(start - t0), ms: Math.round(ms) })
  console.log(`${label.padEnd(24)} ${(ms / 1000).toFixed(2).padStart(6)} s`)
}

const original = await readFile(BACKEND, 'utf8')
const edited = original
  .replace('const flags: Flags = { shop: true }', 'const flags: Flags = { shop: false }')
  .replace(/const plants: Plant\[\] = \[[\s\S]*?\n\]/, plants)
if (!edited.includes('shop: false') || !edited.includes("'Orchid'"))
  throw new Error('fake-backend.ts changed shape; update this script')

try {
  // Flags and data live in the backend, and a reload drops the theme and
  // the current screen, so both backend changes go first, in one reload.
  await step('backend: Shop off, seed', () => writeFile(BACKEND, edited))
  await step('reload the app', reload)
  await step('plants loaded?', () => waitFor('Orchid', 15000))
  await step('Shop tab gone?', async () => {
    if ((await elements()).some((el) => el.label.startsWith('Shop, tab'))) throw new Error('the Shop tab is still there')
  })
  await step('overdue pill?', () => waitFor('3 days late'))
  await step('open Settings', () => tab('Settings'))
  await step('dark mode', () => tap({ label: 'Dark' }))
  await step('open Plants', () => tab('Plants'))
  await step('tap +', () => tap({ id: 'add-plant' }))
  await step('save empty form', () => tap({ id: 'save-plant' }))
  await step('error shown?', () => waitFor('Name is required'))
  await step('type name', () => fill({ id: 'plant-name' }, 'Fiddle leaf fig'))
  await step('type days', () => fill({ id: 'water-days' }, '7'))
  await step('save', () => tap({ id: 'save-plant' }))
  await step('new plant listed?', () => waitFor('Fiddle leaf fig'))
  // Only possible because the example ships a push endpoint; most backends
  // have no way to send one device a message on demand.
  await step('open Inbox', () => tab('Inbox'))
  await step('push a live message', async () => {
    const res = await fetch(`${REALTIME}/push?title=${encodeURIComponent('Monstera has a new leaf')}&body=Spotted%20just%20now.`)
    if (!res.ok) throw new Error(`no realtime server at ${REALTIME}: run \`npm run realtime\``)
  })
  await step('message shown?', () => waitFor('Monstera has a new leaf'))
} finally {
  // The reload also resets the theme, the added plant and the pushed message.
  await step('undo everything', async () => {
    await writeFile(BACKEND, original)
    await reload()
  })
  await step('app back to real?', () => waitFor('Snake plant', 15000))
}

const wall = (performance.now() - t0) / 1000
console.log(`\n${timings.length} steps in ${wall.toFixed(1)} s`)
if (process.env.TIMINGS) await writeFile(process.env.TIMINGS, JSON.stringify({ wallMs: Math.round(wall * 1000), steps: timings }, null, 2))
