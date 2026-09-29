import { describe, expect, mock, test } from 'bun:test'

import { appTools } from '../tools/app'

describe('app.reload', () => {
  test('answers first, then reloads once', async () => {
    const reload = mock(() => {})
    const tool = appTools(reload)['app.reload']
    const run = typeof tool === 'function' ? tool : tool?.run
    expect(run?.()).toEqual({ reloading: true })
    expect(reload).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 120))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
