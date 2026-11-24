// Checks that a dial change reaches the screen, and that dial.restore keeps the saved pick.
// Needs a session (`session start`): it writes .agent-bridge/dials.json. Leaves saved name.size, avatar.radius and card.gap; `dials clear name.size avatar.radius card.gap` removes them.
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

  const savedBy = async (id, value) => {
    // The session writes dials.json a moment after the call.
    for (let waited = 0; saved()[id]?.value !== value; waited += 100) {
      if (waited >= 2000) throw new Error(`dials.json has no ${id} = ${value} after 2 s (is a session running?)`)
      await sleep(100)
    }
  }
  await savedBy('name.size', 22)
  await step('set radius', 'dial.set', 'avatar.radius', 20)
  await savedBy('avatar.radius', 20)

  await step('restore', 'dial.restore')
  expect((await dialValue('name.size')) === 17, 'dial.restore did not put name.size back')
  // A set on another dial after a restore must not overwrite the picks the restore left in the file.
  await step('set gap', 'dial.set', 'card.gap', 20)
  await savedBy('card.gap', 20)
  await sleep(500)
  const file = saved()
  expect(file['name.size']?.value === 22, `dials.json lost the name.size pick: ${JSON.stringify(file['name.size'])}`)
  expect(file['avatar.radius']?.value === 20, `dials.json lost the avatar.radius pick: ${JSON.stringify(file['avatar.radius'])}`)
}
