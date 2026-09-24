// Errors the app logs come back with the next reply.
//   npx agent-bridge run flows/checks/logs.mjs
// Needs the example's dev tools app.logError and app.throwLater
// (src/dev/agent-bridge.tsx): a flow can't add tools. app.throwLater throws
// from a timer, so React Native shows a red box; this check only records.
const expectLog = (logs, message, where) => {
  const found = logs.find((e) => e.level === 'error' && e.message.includes(message))
  if (!found) throw new Error(`no error "${message}" in ${JSON.stringify(logs)}`)
  for (const [key, tool] of Object.entries(where)) {
    if (found[key] !== tool) throw new Error(`${key} is ${found[key]}, wanted ${tool}`)
  }
  return found
}

export default async ({ bridge, call }) => {
  const now = await bridge.timed('app.logError', 'logged by the logs check')
  expectLog(now.logs, 'logged by the logs check', { during: 'app.logError' })

  await bridge.timed('app.throwLater')
  await new Promise((resolve) => setTimeout(resolve, 100))
  const later = await bridge.timed('bridge.ping')
  expectLog(later.logs, 'boom from a timer', { after: 'app.throwLater' })

  const errors = await call('bridge.logs', { level: 'error', limit: 10 })
  expectLog(errors, 'logged by the logs check', { during: 'app.logError' })
  expectLog(errors, 'boom from a timer', { after: 'app.throwLater' })
}
