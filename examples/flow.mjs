// npx @avasapp/agent-bridge run examples/flow.mjs   (or: run examples/ for every *.flow.mjs; each flow ends with a restore)
// Assumes the app registers the tanstack-query and expo-router adapters.
export default async ({ step, call, expect }) => {
  const flags = await call('query.get', ['features'])
  await step('flag: wallet off', 'query.pin', ['features'], { ...flags, wallet: false })
  await step('open Home', 'router.navigate', '/')
  await expect.gone('Wallet')
}
