import { describe, expect, test } from 'bun:test'

import type { ResultMessage } from '../../../shared/protocol'
import { createJournal } from '../journal'

const reply = (value: unknown, loadId = 'L2'): ResultMessage => ({ id: '1', from: 'd', ok: true, value, ms: 0, loadId }) as ResultMessage
const storeData = (original: object, after: object, skipped?: string[]) => ({
  store: { auth: { original, after, ...(skipped && { skipped }) } },
})
const accept = (j: ReturnType<typeof createJournal>, load: string, data: unknown) =>
  j.accept({ ok: true, loadId: load, journal: 1, journalData: data } as ResultMessage)

describe('journal merge of persisted stores', () => {
  test('a second reload keeps the older original and merges keys from the newer entry', async () => {
    const sent: unknown[] = []
    const j = createJournal(async (_t, args) => {
      sent.push(structuredClone(args[0]))
      return reply({ store: { adopted: [], already: [], changed: [], retry: (args[0] as { store: unknown }).store, error: 'not hydrated' } })
    }, 'L1')
    accept(j, 'L1', storeData({ token: 'real' }, { token: 'fake' }))
    j.reloaded(['store'], 'L2')
    await j.adopt()
    accept(j, 'L2', storeData({ theme: 'light' }, { theme: 'dark' }))
    j.reloaded(['store'], 'L3')
    await j.adopt()
    expect(sent.at(-1)).toEqual({
      store: { auth: { original: { token: 'real', theme: 'light' }, after: { token: 'fake', theme: 'dark' } } },
    })
  })

  test('the newer after wins per key, an older absent original stays absent, skipped names are joined', async () => {
    const sent: unknown[] = []
    const j = createJournal(async (_t, args) => {
      sent.push(structuredClone(args[0]))
      return reply({ store: { adopted: [], already: [], changed: [], retry: (args[0] as { store: unknown }).store } })
    }, 'L1')
    accept(j, 'L1', storeData({}, { token: 'fake' }, ['a']))
    j.reloaded(['store'], 'L2')
    await j.adopt()
    accept(j, 'L2', storeData({ token: 'fake' }, { token: 'fake2' }, ['b']))
    j.reloaded(['store'], 'L3')
    await j.adopt()
    expect(sent.at(-1)).toEqual({ store: { auth: { original: {}, after: { token: 'fake2' }, skipped: ['a', 'b'] } } })
  })
})

describe('journal adopt tries', () => {
  test('a lost-connection result is not a try and gives no reason', async () => {
    let calls = 0
    const j = createJournal(async () => {
      calls += 1
      return { id: '', from: '', ok: false, error: 'socket closed', ms: 0 } as ResultMessage
    }, 'L1')
    accept(j, 'L1', { mmkv: { kv: { a: { original: 'x', written: 'y' } } } })
    j.reloaded(['mmkv'], 'L2')
    for (let i = 0; i < 5; i++) expect(await j.adopt()).toBe('')
    expect(calls).toBe(5)
    expect(j.hasCarry()).toBe(true)
  })

  test('a timeout while the app still answers counts as a try, and the third gives up', async () => {
    const j = createJournal(
      async () => {
        throw new Error('No reply to "bridge.adopt" within 200 ms')
      },
      'L1',
      async () => true,
    )
    accept(j, 'L1', { mmkv: { kv: { a: { original: 'x', written: 'y' } } } })
    j.reloaded(['mmkv'], 'L2')
    const notes = [await j.adopt(), await j.adopt(), await j.adopt()]
    expect(notes[0]).toContain('will retry')
    expect(notes[2]).toContain('could not re-arm after the reload: mmkv:kv (timed out)')
    expect(j.hasCarry()).toBe(false)
  })

  test('a timeout with the app gone is not a try', async () => {
    const j = createJournal(
      async () => {
        throw new Error('No reply')
      },
      'L1',
      async () => false,
    )
    accept(j, 'L1', { mmkv: { kv: { a: { original: 'x', written: 'y' } } } })
    j.reloaded(['mmkv'], 'L2')
    for (let i = 0; i < 4; i++) expect(await j.adopt()).toBe('')
    expect(j.hasCarry()).toBe(true)
  })

  test('a reply that lands after another reload does not touch the new carry', async () => {
    let release: (r: ResultMessage) => void = () => {}
    const j = createJournal(() => new Promise<ResultMessage>((r) => (release = r)), 'L1')
    accept(j, 'L1', { mmkv: { kv: { a: { original: 'x', written: 'y' } } } })
    j.reloaded(['mmkv'], 'L2')
    const pending = j.adopt()
    accept(j, 'L2', { mmkv: { kv: { b: { original: 'p', written: 'q' } } } })
    j.reloaded(['mmkv'], 'L3')
    release(reply({ mmkv: { adopted: ['kv:a'], already: [], changed: [] } }, 'L2'))
    expect(await pending).toBe('')
    expect(j.hasCarry()).toBe(true)
  })
})
