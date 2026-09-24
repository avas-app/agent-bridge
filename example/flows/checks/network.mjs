// Checks net.* on a running example app: the log sees the fake backend,
// agent mocks override it, and net.restore puts it back.
//   npx agent-bridge run flows/checks/network.mjs
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export default async ({ step, call }) => {
  const check = (ok, message) => {
    if (!ok) throw new Error(message)
  }
  // Polls net.log until an entry matches, so a check doesn't wait out
  // TanStack Query's retries on a failed request.
  const waitForEntry = async (url, matches, what) => {
    for (let i = 0; i < 40; i++) {
      const entries = await call('net.log', { url })
      const hit = entries.find(matches)
      if (hit) return hit
      await sleep(100)
    }
    throw new Error(`no ${what} in net.log: ${JSON.stringify(await call('net.log', { url, limit: 5 }))}`)
  }

  await step('clean slate', 'net.restore')
  await step('clear log', 'net.clear')
  await step('refetch plants', 'query.refetch', ['plants'])
  const plants = await step('log has GET /plants', 'net.log', { url: '/plants', method: 'GET' })
  check(plants.length >= 1 && plants[0].status === 200, `expected GET /plants 200, got ${JSON.stringify(plants[0])}`)

  await step('inbox → 500', 'net.mock', { url: '/inbox' }, { status: 500, json: { error: 'down' } })
  // Not awaited: the query retries a failed fetch for seconds.
  const failing = [call('query.refetch', ['inbox']).catch(() => {})]
  await waitForEntry('/inbox', (e) => e.status === 500 && e.mocked, 'mocked 500 for /inbox')

  await step('inbox → offline', 'net.mock', { url: '/inbox' }, { offline: true })
  failing.push(call('query.refetch', ['inbox']).catch(() => {}))
  await waitForEntry('/inbox', (e) => e.mocked && /offline/.test(e.error ?? ''), 'mocked offline /inbox')

  const removed = await step('restore', 'net.restore')
  check(removed === 2, `net.restore removed ${removed} mocks, wanted 2`)
  const inbox = await step('refetch inbox', 'query.refetch', ['inbox'])
  check(Array.isArray(inbox) && inbox.some((m) => m.title === 'Fern is thirsty'), `inbox is not the real data: ${JSON.stringify(inbox)}`)
  const [last] = await call('net.log', { url: '/inbox', limit: 1 })
  check(last.status === 200, `last /inbox request: ${JSON.stringify(last)}`)
  await Promise.all(failing)
}
