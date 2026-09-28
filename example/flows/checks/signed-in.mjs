// Checks the signedIn scenario (src/dev/scenarios.ts) on a running example
// app. `agent-bridge run` applies it before the flow and runs bridge.restore
// after, even if a check fails, so the app ends up signed out again.
//   npx agent-bridge run flows/checks/signed-in.mjs
// One request is blocked on purpose, so the run reports one app error.
export const scenario = { name: 'signedIn', options: { user: { name: 'Grace Gardener' } } }

export default async ({ step, call, bridge, scenarios }) => {
  const check = (ok, message) => {
    if (!ok) throw new Error(message)
  }
  check(scenarios.signedIn.user.name === 'Grace Gardener', `apply returned ${JSON.stringify(scenarios.signedIn)}`)

  const auth = await step('auth store', 'store.get', 'auth')
  check(auth.token === 'local-token', `not signed in: ${JSON.stringify(auth)}`)

  await step('open settings', 'router.navigate', '/settings')
  await step('signed in as Grace', 'screen.waitFor', 'Grace Gardener')
  const [me] = await call('net.log', { url: '/me', limit: 1 })
  check(me?.mocked && me.status === 200, `GET /me did not come from the fixture: ${JSON.stringify(me)}`)

  // The fake backend's routes are mocks too, so they still answer.
  const plants = await step('fake backend answers', 'app.fetch', '/plants')
  check(plants.status === 200, `GET /plants: ${plants.status}`)

  // Nothing answers /orders: strict mode fails it and says which request.
  const { value: orders, logs } = await bridge.timed('app.fetch', '/orders')
  check(orders.status === 501, `GET /orders reached ${orders.status}, wanted a 501`)
  check(logs.some((e) => e.message.includes('no mock for GET')), 'the blocked request was not reported')
  const strict = await step('blocked list', 'net.strict')
  check(strict.strict && strict.blocked.some((b) => b.url.endsWith('/orders')), `net.strict: ${JSON.stringify(strict)}`)

  // The gate keeps the socket off while the fake token is in place.
  const connection = await step('realtime held off', 'realtime.connection')
  check(connection.real === 'disconnected', `the socket is ${connection.real}`)
}
