import { afterEach, describe, expect, test } from 'bun:test'

import { createScreen } from '..'
import { WINDOW, host, rnText, tree } from './fake-tree'
import { installHook } from './fake-tree'

let remove = () => {}
afterEach(() => remove())

function setup(...children: ReturnType<typeof host>[]) {
  const root = tree(host(), ...children)
  const fake = installHook([{ current: root }])
  remove = fake.remove
  const screen = createScreen({ roots: () => [root], window: () => WINDOW })
  /** Re-renders the screen with new children, then commits. */
  const render = (...next: ReturnType<typeof host>[]) => {
    tree(root, ...next)
    fake.commit()
  }
  return { screen, render }
}

describe('waitFor', () => {
  test('resolves at once when the target is already there', async () => {
    const { screen } = setup(rnText('My plants'))
    const result = await screen.waitFor('My plants')
    expect(result.element).toMatchObject({ kind: 'text', text: 'My plants' })
    expect(result.ms).toBeLessThan(5)
  })

  test('re-checks on the commit that renders it, substring included', async () => {
    const { screen, render } = setup(rnText('Add plant'))
    setTimeout(() => render(rnText('Name is required, sorry')), 10)
    const result = await screen.waitFor('Name is required')
    expect(result.element?.text).toBe('Name is required, sorry')
    // Found on the commit, not on the 50 ms poll.
    expect(result.ms).toBeLessThan(40)
  })

  test('with gone, resolves when the target leaves the screen', async () => {
    const { screen, render } = setup(rnText('Saving…'))
    setTimeout(() => render(rnText('Saved')), 10)
    const result = await screen.waitFor('Saving…', { gone: true })
    expect(result.element).toBeUndefined()
  })

  test('times out with what is on screen', async () => {
    const { screen } = setup(rnText('My plants'))
    expect(screen.waitFor('Monstera', { timeoutMs: 80 })).rejects.toThrow(
      /Timed out after 80 ms waiting for "Monstera" to appear. On screen: text "My plants"/,
    )
  })

  test('polls when no commit is reported', async () => {
    const root = tree(host(), rnText('Loading'))
    const screen = createScreen({ roots: () => [root], window: () => WINDOW })
    setTimeout(() => tree(root, rnText('Loaded')), 10)
    const result = await screen.waitFor({ text: 'Loaded' }, { timeoutMs: 500 })
    expect(result.ms).toBeGreaterThanOrEqual(40)
  })
})
