// Device check for screen.snapshot, press, fill and waitFor, through the
// Add plant form. Throws on the first mismatch.
//   npx agent-bridge run flows/checks/screen.mjs
export default async ({ step }) => {
  const name = `Check fern ${Date.now() % 100000}`
  const expect = (ok, message) => {
    if (!ok) throw new Error(message)
  }

  await step('reset', 'app.reset')
  await step('open Plants', 'router.navigate', '/')
  await step('plants loaded', 'screen.waitFor', 'plants ·')

  const { elements } = await step('snapshot', 'screen.snapshot')
  const add = elements.find((e) => e.testID === 'add-plant')
  expect(
    add?.kind === 'button' && add.label === 'Add plant',
    `add button not in snapshot: ${JSON.stringify(add ?? elements.slice(0, 8))}`,
  )
  expect(
    !elements.some((e) => e.testID === 'save-plant'),
    'the hidden Add plant tab leaked into the snapshot',
  )

  await step('press +', 'screen.press', 'add-plant')
  await step('form open', 'screen.waitFor', 'save-plant')

  await step('save empty', 'screen.press', 'save-plant')
  await step('name error', 'screen.waitFor', 'Name is required')

  const filled = await step('fill name', 'screen.fill', 'plant-name', name)
  expect(filled.element.value === name, `name input shows ${JSON.stringify(filled.element.value)}`)
  await step('fill species', 'screen.fill', 'plant-species', 'Nephrolepis')
  const days = await step('fill days 120', 'screen.fill', 'water-days', '120')
  expect(days.filled === '12', `maxLength ignored: filled ${days.filled}`)
  await step('fill days 0', 'screen.fill', 'water-days', '0')
  await step('save bad days', 'screen.press', 'save-plant')
  await step('days error', 'screen.waitFor', 'Water every 1–60 days')
  await step('name error gone', 'screen.waitFor', 'Name is required', { gone: true })

  await step('fill days 14', 'screen.fill', 'water-days', '14')
  await step('save', 'screen.press', 'save-plant')
  const listed = await step('plant listed', 'screen.waitFor', name)
  expect(listed.element?.text === name, `listed ${JSON.stringify(listed.element)}`)
  await step('form gone', 'screen.waitFor', 'save-plant', { gone: true })
  await step('days error gone', 'screen.waitFor', 'Water every 1–60 days', { gone: true })

  await step('restore', 'router.navigate', '/')
}
