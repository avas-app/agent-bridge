// Drives the example app the way a coding agent would, with no taps.
//   npx agent-bridge run flows/demo.mjs              no pauses
//   PACE=paced npx agent-bridge run flows/demo.mjs   holds each step for viewers
const HOLD_MS = { none: 0, paced: 1200 }[process.env.PACE ?? 'none'] ?? Number(process.env.PACE)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const plants = [
  { id: 's1', name: 'Orchid', species: 'Phalaenopsis', emoji: '🥀', waterInDays: -3 },
  { id: 's2', name: 'Fern with a name long enough to wrap', species: 'Nephrolepis', emoji: '🌿', waterInDays: 0 },
  { id: 's3', name: 'Cactus', species: 'Echinopsis', emoji: '🌵', waterInDays: 60 },
]

const inbox = [
  { id: 's1', icon: 'sparkles', tint: 'accent', title: 'Hello from your agent', body: 'Seeded by the agent in one call.', time: 'now', unread: true },
  { id: 's2', icon: 'water', tint: 'danger', title: 'Orchid is 3 days late', body: 'Water it today.', time: 'now', unread: true },
]

export default async ({ step, call }) => {
  // Each HUD line goes out alongside the step's own call and carries the
  // previous step's round trip, so a step still costs one round trip.
  let steps = 0
  let last = null
  const shown = async (label, tool, ...args) => {
    const hud = call('hud.push', label, last)
    const t0 = performance.now()
    const value = await step(label, tool, ...args)
    last = performance.now() - t0
    steps += 1
    await hud
    if (HOLD_MS) {
      await call('hud.roundTrip', last)
      await sleep(HOLD_MS)
    }
    return value
  }
  const expectOnScreen = (result, wanted) => {
    if (result.onScreen !== wanted)
      throw new Error(`onScreen is ${result.onScreen}, wanted ${wanted}`)
  }

  const flags = await call('query.get', ['flags'])
  await call('hud.show', 'agent-bridge · demo.mjs')
  if (HOLD_MS) await sleep(HOLD_MS)
  const t0 = performance.now()

  await shown('open Plants', 'router.navigate', '/')
  await shown('seed plants', 'query.pin', ['plants'], plants)
  expectOnScreen(await shown('overdue pill?', 'screen.findText', '3 days late'), 1)
  await shown('flag: Shop off', 'query.pin', ['flags'], { ...flags, shop: false })
  expectOnScreen(await shown('Shop tab gone?', 'screen.findText', 'Shop', { exact: true }), 0)
  await shown('dark mode', 'store.call', 'settings', 'setTheme', 'dark')
  await shown('seed Inbox', 'query.pin', ['inbox'], inbox)
  await shown('open Inbox', 'router.navigate', '/inbox')
  expectOnScreen(await shown('agent message?', 'screen.findText', 'Seeded by the agent'), 1)
  await shown('reset everything', 'app.reset')

  const wall = (performance.now() - t0) / 1000
  const summary = HOLD_MS
    ? `${steps} steps, paced for viewers`
    : `${steps} steps in ${wall.toFixed(1)} s, no pauses`
  await call('hud.setTitle', summary, last)
}
