// router.current must see a navigation the moment router.navigate returns.
//   npx agent-bridge run flows/checks/router.mjs
export default async ({ call }) => {
  const expectPath = async (wanted) => {
    const current = await call('router.current')
    if (current.pathname !== wanted)
      throw new Error(`pathname is ${current.pathname}, wanted ${wanted}: ${JSON.stringify(current)}`)
    return current
  }

  await call('router.navigate', '/inbox')
  const inbox = await expectPath('/inbox')
  await call('router.navigate', '/')
  const home = await expectPath('/')

  // Recorded, not asserted: whether tabs go back from Plants depends on their backBehavior.
  const couldGoBack = await call('router.back')
  const afterBack = await call('router.current')
  if (couldGoBack && afterBack.pathname === home.pathname)
    throw new Error(`router.back returned true but pathname stayed ${afterBack.pathname}`)

  console.log(JSON.stringify({ inbox, home, back: { couldGoBack, now: afterBack } }, null, 2))
}
