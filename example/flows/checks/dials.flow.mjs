// Checks that a dial change reaches the screen, and that dial.restore keeps the saved pick.
// Needs a session (`session start`): it writes .agent-bridge/dials.json. Leaves a saved name.size; `dials clear name.size` removes it.
//   npx @avasapp/agent-bridge run flows/checks/dials.flow.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const saved = () => {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), '.agent-bridge', 'dials.json'), 'utf8'))
  } catch {
    return {}
  }
}

export default async ({ step, call }) => {
  const expect = (ok, message) => {
    if (!ok) throw new Error(message)
  }
  const dialValue = async (id) => (await call('dial.list')).find((d) => d.id === id)?.value

  await step('open Plants', 'router.navigate', '/')
  await step('plants loaded', 'screen.waitFor', 'plants ·')

  await step('set size', 'dial.set', 'name.size', 22)
  expect((await dialValue('name.size')) === 22, 'name.size did not change')
  const fern = await call('screen.findText', 'Fern', { exact: true })
  expect(fern.onScreen >= 1, `"Fern" not on screen with name.size 22: ${JSON.stringify(fern)}`)

  // The session writes dials.json a moment after the call.
  for (let waited = 0; saved()['name.size']?.value !== 22; waited += 100) {
    if (waited >= 2000) throw new Error('dials.json has no name.size = 22 after 2 s (is a session running?)')
    await sleep(100)
  }

  await step('restore', 'dial.restore')
  expect((await dialValue('name.size')) === 17, 'dial.restore did not put name.size back')
  await sleep(500)
  const entry = saved()['name.size']
  expect(entry && entry.history.includes(22), `dials.json lost name.size: ${JSON.stringify(entry)}`)
}
