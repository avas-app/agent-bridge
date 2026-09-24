// Checks that bridge.restore undoes a pin and a store action.
//   npx agent-bridge run flows/checks/restore.mjs
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const seeded = [
  { id: 's1', name: 'Seeded orchid', species: 'Phalaenopsis', emoji: '🥀', waterInDays: -3 },
]

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export default async ({ step, call }) => {
  const theme = await call('store.get', 'settings', 'theme')

  await step('open Plants', 'router.navigate', '/')
  await step('seed plants', 'query.pin', ['plants'], seeded)
  await step('dark mode', 'store.call', 'settings', 'setTheme', 'dark')
  await step('restore', 'bridge.restore')

  const after = await call('store.get', 'settings', 'theme')
  if (after !== theme) throw new Error(`theme is ${after}, wanted ${theme}`)

  const pinned = (await call('query.list')).filter((q) => q.pinned)
  if (pinned.length) throw new Error(`still pinned: ${pinned.map((q) => JSON.stringify(q.key)).join(', ')}`)

  // The real plants come back after the refetch (about 400 ms).
  for (let waited = 0; ; waited += 100) {
    const fern = await call('screen.findText', 'Fern', { exact: true })
    if (fern.onScreen >= 1) break
    if (waited >= 2000) throw new Error(`"Fern" not back after 2 s: ${JSON.stringify(fern)}`)
    await sleep(100)
  }
  const plants = await call('query.get', ['plants'])
  if (same(plants, seeded)) throw new Error('plants still hold the seed')
}
