// The demo without agent-bridge: the same checks as demo.mjs, done the way
// an agent does them with agent-device alone. It taps and types through the
// UI, edits the fake backend and reloads to change flags and data, and asks
// the realtime server to push a message. Recorded next to demo.mjs for the
// side-by-side comparison.
//
//   agent-device open host.exp.Exponent "exp://<metro host>:<port>" --platform ios --device "<sim>"
//   npm run realtime                                  # in another terminal
//   METRO=localhost:8081 node flows/demo-agent-device.mjs
//
// Run it from the directory you opened the agent-device session from, on the
// Metro machine: it edits src/dev/fake-backend.ts and puts it back at the end.
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
const [METRO_HOST, METRO_PORT] = (process.env.METRO ?? 'localhost:8081').split(':')
const REALTIME = process.env.REALTIME_URL ?? 'http://localhost:8138'
const BACKEND = new URL('../src/dev/fake-backend.ts', import.meta.url)

// Same edge cases as demo.mjs seeds with query.pin.
const plants = `const plants: Plant[] = [
  { id: 's1', name: 'Orchid', species: 'Phalaenopsis', emoji: '🥀', waterInDays: -3 },
  { id: 's2', name: 'Fern with a name long enough to wrap', species: 'Nephrolepis', emoji: '🌿', waterInDays: 0 },
  { id: 's3', name: 'Cactus', species: 'Echinopsis', emoji: '🌵', waterInDays: 60 },
]`

const device = (...args) => run('agent-device', args, { maxBuffer: 16 * 1024 * 1024 })
const reload = () => device('metro', 'reload', '--metro-host', METRO_HOST, '--metro-port', METRO_PORT)

// On the iOS 27 simulator, agent-device counts UIKit's full-screen floating
// bar container as covering everything above the tab bar and won't press or
// fill it by selector (callstack/agent-device#2996). Look up the element's
// frame and use its centre instead.
const center = async (query) => {
  const args = query.includes('=') ? ['get', 'attrs', query] : ['find', query, 'get', 'attrs']
  const { stdout } = await device(...args, '--json')
  const { x, y, width, height } = JSON.parse(stdout).data.node.rect
  return [String(Math.round(x + width / 2)), String(Math.round(y + height / 2))]
}
const tap = async (query) => device('press', ...(await center(query)), '--settle')
const fill = async (query, text) => device('fill', ...(await center(query)), text, '--settle')
// Tab labels carry their position ("Inbox, tab, 4 of 5"), which moves when
// the Shop tab goes, so find them by prefix.
const tab = (name) => device('find', `${name}, tab`, 'click', '--first')

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
  await step('plants loaded?', () => device('wait', 'text', 'Orchid', '15000'))
  await step('Shop tab gone?', async () => {
    const { stdout } = await device('snapshot', '-i')
    if (stdout.includes('Shop, tab')) throw new Error('the Shop tab is still there')
  })
  await step('overdue pill?', () => device('wait', 'text', '3 days late'))
  await step('open Settings', () => tab('Settings'))
  await step('dark mode', () => tap('Dark'))
  await step('open Plants', () => tab('Plants'))
  await step('tap +', () => tap('label="Add plant"'))
  await step('save empty form', () => tap('id="save-plant"'))
  await step('error shown?', () => device('wait', 'text', 'Name is required'))
  await step('type name', () => fill('id="plant-name"', 'Fiddle leaf fig'))
  await step('type days', () => fill('id="water-days"', '7'))
  await step('save', () => tap('id="save-plant"'))
  await step('new plant listed?', () => device('wait', 'text', 'Fiddle leaf fig'))
  // Only possible because the example ships a push endpoint; most backends
  // have no way to send one device a message on demand.
  await step('open Inbox', () => tab('Inbox'))
  await step('push a live message', async () => {
    const res = await fetch(`${REALTIME}/push?title=${encodeURIComponent('Monstera has a new leaf')}&body=Spotted%20just%20now.`)
    if (!res.ok) throw new Error(`no realtime server at ${REALTIME}: run \`npm run realtime\``)
  })
  await step('message shown?', () => device('wait', 'text', 'Monstera has a new leaf'))
} finally {
  // The reload also resets the theme, the added plant and the pushed message.
  await step('undo everything', async () => {
    await writeFile(BACKEND, original)
    await reload()
  })
  await step('app back to real?', () => device('wait', 'text', 'Snake plant', '15000'))
}

const wall = (performance.now() - t0) / 1000
console.log(`\n${timings.length} steps in ${wall.toFixed(1)} s`)
if (process.env.TIMINGS) await writeFile(process.env.TIMINGS, JSON.stringify({ wallMs: Math.round(wall * 1000), steps: timings }, null, 2))
