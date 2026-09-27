import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as Ably from 'ably'

import type { ToolFn, Tools } from '../../runtime/types'
import { ablyTools } from '../ably'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

// A real client that never connects. Channels don't attach on subscribe, so
// nothing touches the network.
const clients: Ably.Realtime[] = []
function setup() {
  const client = new Ably.Realtime({ key: 'app.key:secret', autoConnect: false })
  clients.push(client)
  const tools = ablyTools(client)
  const channel = (name: string) => client.channels.get(name, { attachOnSubscribe: false })
  // What ably-js does with a message off the wire, once decoded.
  const deliver = (name: string, message: Partial<Ably.Message>) =>
    (channel(name) as unknown as { subscriptions: { emit: (e?: string, m?: unknown) => void } })
      .subscriptions.emit(message.name, message)
  return { client, tools, channel, deliver }
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

describe('ablyTools', () => {
  test('logs real messages once, and delivers injected Ably messages to every listener', async () => {
    const { tools, channel, deliver } = setup()
    const a = mock()
    const b = mock()
    await channel('chat').subscribe(a)
    await channel('chat').subscribe(b)

    deliver('chat', { id: 'wire-1', name: 'message', data: { text: 'hi' } })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    const result = run(tools, 'realtime.emit', 'chat', { name: 'message', data: { text: 'fake' } })
    expect(result).toEqual({ id: 'agent-bridge-1', delivered: 2 })
    expect(a).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'agent-bridge-1', name: 'message', data: { text: 'fake' }, timestamp: expect.any(Number) }),
    )

    expect(run(tools, 'realtime.log')).toEqual([
      expect.objectContaining({ channel: 'chat', event: 'message', id: 'agent-bridge-1', injected: true }),
      expect.objectContaining({ channel: 'chat', event: 'message', id: 'wire-1', data: { text: 'hi' }, injected: false }),
    ])
    expect(run(tools, 'realtime.channels')).toEqual([
      { name: 'chat', listeners: 2, muted: false, state: 'initialized' },
    ])
  })

  test('honours event-name filters for injected messages', async () => {
    const { tools, channel } = setup()
    const typing = mock()
    const either = mock()
    await channel('chat').subscribe('typing', typing)
    await channel('chat').subscribe(['typing', 'message'], either)

    expect(run(tools, 'realtime.emit', 'chat', { name: 'message', data: 'x' })).toMatchObject({ delivered: 1 })
    expect(typing).not.toHaveBeenCalled()
    expect(either).toHaveBeenCalledTimes(1)
  })

  test('mute drops real messages; unsubscribe forgets listeners in each form', async () => {
    const { tools, channel, deliver } = setup()
    const a = mock()
    const b = mock()
    await channel('chat').subscribe(a)
    await channel('chat').subscribe('typing', b)

    run(tools, 'realtime.mute', 'chat')
    deliver('chat', { name: 'typing', data: 1 })
    expect(a).not.toHaveBeenCalled()
    run(tools, 'realtime.restore')
    deliver('chat', { name: 'typing', data: 2 })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    channel('chat').unsubscribe('typing', b)
    deliver('chat', { name: 'typing', data: 3 })
    expect(b).toHaveBeenCalledTimes(1)
    expect(run(tools, 'realtime.channels')).toMatchObject([{ name: 'chat', listeners: 1 }])

    channel('chat').unsubscribe(a)
    deliver('chat', { name: 'typing', data: 4 })
    expect(a).toHaveBeenCalledTimes(2)
    expect(run(tools, 'realtime.channels')).toEqual([])

    await channel('chat').subscribe(a)
    channel('chat').unsubscribe()
    expect(run(tools, 'realtime.channels')).toEqual([])
  })

  test('taps channels that existed before, and patches a client only once', async () => {
    const client = new Ably.Realtime({ key: 'app.key:secret', autoConnect: false })
    clients.push(client)
    const early = client.channels.get('early', { attachOnSubscribe: false })
    const tools = ablyTools(client)
    expect(ablyTools(client)).toBe(tools)

    const a = mock()
    await early.subscribe(a)
    expect(run(tools, 'realtime.emit', 'early', { name: 'x' })).toMatchObject({ delivered: 1 })
  })

  test('fakes connection states through the connection events, then goes back', () => {
    const { client, tools, channel, deliver } = setup()
    const changes = mock()
    client.connection.on(changes)
    const a = mock()
    void channel('chat').subscribe(a)

    run(tools, 'realtime.connection', 'disconnected')
    expect(client.connection.state).toBe('disconnected')
    expect(changes).toHaveBeenLastCalledWith(
      expect.objectContaining({ previous: 'initialized', current: 'disconnected', reason: { message: 'Faked by agent-bridge' } }),
    )
    deliver('chat', { name: 'message', data: 'real' })
    expect(a).not.toHaveBeenCalled()

    // A real change while faked updates the real state, but the app doesn't hear it.
    const calls = changes.mock.calls.length
    ;(client.connection as unknown as { state: string }).state = 'connecting'
    ;(client.connection as unknown as { emit: (...a: unknown[]) => void }).emit('connecting', { current: 'connecting' })
    expect(changes).toHaveBeenCalledTimes(calls)
    expect(run(tools, 'realtime.connection')).toEqual({ state: 'disconnected', real: 'connecting', faked: true })

    run(tools, 'realtime.restore')
    expect(client.connection.state).toBe('connecting')
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ previous: 'disconnected', current: 'connecting' }))
    expect(() => run(tools, 'realtime.connection', 'offline')).toThrow('Known: initialized, connecting')
  })
})
