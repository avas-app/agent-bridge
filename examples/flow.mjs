// npx agent-bridge run examples/flow.mjs
// Assumes the app registers the tanstack-query and expo-router adapters.
export default async ({ step, call }) => {
  const flags = await call('query.get', ['features'])
  await step('flag: wallet off', 'query.pin', ['features'], { ...flags, wallet: false })
  await step('open Home', 'router.navigate', '/')
  await step('Wallet tab gone?', 'screen.findText', 'Wallet', { exact: true })
  await step('put flags back', 'query.unpinAll')
}
