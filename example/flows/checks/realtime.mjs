// Checks realtime.* on a running example app with its realtime server: real
// pushes arrive, mute drops them, emit fakes one, a faked disconnect drops
// them without replaying later, and bridge.restore puts it all back.
//   npm run realtime                               # in another terminal
//   npx agent-bridge run flows/checks/realtime.mjs
const SERVER = process.env.REALTIME_URL ?? 'http://localhost:8138'
const CHANNEL = 'inbox:new'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export default async ({ step, call }) => {
  const check = (ok, message) => {
    if (!ok) throw new Error(message)
  }
  const run = Date.now().toString(36)
  // A real message, pushed by the server over the socket.
  const push = async (title) => {
    const res = await fetch(`${SERVER}/push?title=${encodeURIComponent(`${title} ${run}`)}`).catch(() => null)
    check(res?.ok, `no realtime server at ${SERVER}: run \`npm run realtime\``)
    const { clients } = await res.json()
    check(clients > 0, 'the app is not connected to the realtime server')
    await sleep(300)
    return `${title} ${run}`
  }
  const lastLogged = async () => (await call('realtime.log', { channel: CHANNEL, limit: 1 }))[0]

  await step('clean slate', 'bridge.restore')
  const channels = await step('channels', 'realtime.channels')
  check(channels.some((c) => c.name === CHANNEL && c.listeners > 0), `nothing listens on ${CHANNEL}: ${JSON.stringify(channels)}`)
  await step('open inbox', 'router.navigate', '/inbox')
  // Let the inbox's own fetch land first, or it replaces what arrives meanwhile.
  await step('settle inbox', 'query.refetch', ['inbox'])

  const live = await push('Live')
  await step('real push shown', 'screen.waitFor', live)

  await step('mute', 'realtime.mute', CHANNEL)
  const muted = await push('Muted')
  const mutedEntry = await lastLogged()
  check(mutedEntry?.data?.title === muted && mutedEntry.dropped === 'muted', `muted push not logged as dropped: ${JSON.stringify(mutedEntry)}`)
  const hidden = await step('muted push hidden', 'screen.findText', muted)
  check(hidden.found === 0, `muted push reached the screen`)

  const fake = `Faked ${run}`
  const sent = await step('emit while muted', 'realtime.emit', CHANNEL, {
    id: `fake-${run}`, icon: 'sparkles', tint: 'violet', title: fake, body: 'Sent by the agent', time: 'Now', unread: true,
  })
  check(sent.delivered === 1, `emit delivered to ${sent.delivered} listeners`)
  await step('fake shown', 'screen.waitFor', fake)
  await step('unmute', 'realtime.unmute', CHANNEL)

  await step('fake disconnect', 'realtime.connection', 'disconnected')
  const offline = await push('Offline')
  const offlineEntry = await lastLogged()
  check(offlineEntry?.data?.title === offline && offlineEntry.dropped === 'connection', `offline push not logged as dropped: ${JSON.stringify(offlineEntry)}`)

  const undone = await step('restore', 'bridge.restore')
  check(undone['realtime.restore'].connectionFaked === true, `restore: ${JSON.stringify(undone['realtime.restore'])}`)
  const back = await push('Back')
  await step('real push shown again', 'screen.waitFor', back)
  const replayed = await step('offline push never replayed', 'screen.findText', offline)
  check(replayed.found === 0, 'a push from the faked disconnect reached the screen later')
}
