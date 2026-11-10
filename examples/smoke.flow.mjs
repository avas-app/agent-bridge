// npx @avasapp/agent-bridge run examples/smoke.flow.mjs   (or: run examples/ for every *.flow.mjs; each flow ends with a restore)
// Assumes the app registers the tanstack-query and expo-router adapters.
export default async ({ step, call, expect }) => {
  const flags = await call('query.get', ['features'])
  await step('flag: wallet off', 'query.pin', ['features'], { ...flags, wallet: false })
  await step('open Home', 'router.navigate', '/')
  await expect.result('screen.findText', ['Wallet', { exact: true }], { found: 0 })
}
