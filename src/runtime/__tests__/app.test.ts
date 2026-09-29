import { describe, expect, mock, test } from 'bun:test'

import { appTools, type ExpoHost, selectReload } from '../tools/app'

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

describe('selectReload', () => {
  test("uses Expo's reloadAppAsync when the app has it", () => {
    const devSettings = mock(() => {})
    const reloadAppAsync = mock(async (_reason?: string) => {})
    selectReload({ expo: { reloadAppAsync } }, devSettings)()
    expect(reloadAppAsync).toHaveBeenCalledTimes(1)
    expect(reloadAppAsync.mock.calls[0]?.[0]).toBe('agent-bridge app.reload')
    expect(devSettings).not.toHaveBeenCalled()
  })

  test('calls reloadAppAsync on the expo object', () => {
    const host = {
      expo: {
        self: 'expo',
        reloadAppAsync(this: { self?: string }) {
          seen = this?.self
        },
      },
    }
    let seen: string | undefined
    selectReload(host, () => {})()
    expect(seen).toBe('expo')
  })

  test('falls back to DevSettings.reload without Expo', () => {
    const devSettings = mock(() => {})
    selectReload({}, devSettings)()
    selectReload({ expo: {} }, devSettings)()
    expect(devSettings).toHaveBeenCalledTimes(2)
  })

  test("falls back when Expo's reload throws or rejects", async () => {
    const devSettings = mock(() => {})
    selectReload(
      {
        expo: {
          reloadAppAsync: () => {
            throw new Error('no')
          },
        },
      },
      devSettings,
    )()
    expect(devSettings).toHaveBeenCalledTimes(1)
    const rejects = async () => Promise.reject(new Error('no'))
    selectReload({ expo: { reloadAppAsync: rejects } }, devSettings)()
    await new Promise((r) => setTimeout(r, 0))
    expect(devSettings).toHaveBeenCalledTimes(2)
  })

  test('reads the host at reload time, not when the tools are built', () => {
    const host: ExpoHost = {}
    const devSettings = mock(() => {})
    const reload = selectReload(host, devSettings)
    const reloadAppAsync = mock(async () => {})
    host.expo = { reloadAppAsync }
    reload()
    expect(reloadAppAsync).toHaveBeenCalledTimes(1)
    expect(devSettings).not.toHaveBeenCalled()
  })
})
