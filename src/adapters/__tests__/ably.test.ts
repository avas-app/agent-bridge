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

  test('an injected message has the fields of one ably-js decodes off the wire', async () => {
    const { tools, channel } = setup()
    const a = mock()
    await channel('chat').subscribe(a)

    const real = await Ably.Realtime.Message.fromEncoded({
      id: 'wire:0:0',
      name: 'typing',
      data: { user: 'sam' },
      timestamp: 5,
      clientId: 'c',
      connectionId: 'k',
      extras: { headers: { h: 'v' } },
      serial: 's',
      version: { serial: 's', timestamp: 5 },
    })
    run(tools, 'realtime.emit', 'chat', {
      name: 'typing',
      data: { user: 'sam' },
      clientId: 'c',
      connectionId: 'k',
      extras: { headers: { h: 'v' } },
      serial: 's',
    })
    const injected = a.mock.calls[0]![0] as Record<string, unknown>
    const own = (m: object) => Object.keys(m).filter((k) => typeof (m as never)[k] !== 'function').sort()
    expect(own(injected)).toEqual(own(real).filter((k) => k !== 'encoding'))
    expect(injected).toMatchObject({
      name: 'typing',
      action: real.action,
      annotations: real.annotations,
      data: real.data,
      extras: real.extras,
      clientId: 'c',
      connectionId: 'k',
      id: 'agent-bridge-1',
      serial: 's',
      timestamp: expect.any(Number),
      version: { serial: 's', timestamp: injected.timestamp },
    })
  })

  test('version follows the passed serial and timestamp; serial defaults per message', async () => {
    const { tools, channel } = setup()
    const a = mock()
    await channel('chat').subscribe(a)
    run(tools, 'realtime.emit', 'chat', { name: 'x', timestamp: 5, serial: 's' })
    run(tools, 'realtime.emit', 'chat', { name: 'x' })
    run(tools, 'realtime.emit', 'chat', { name: 'x', event: 'y' })
    const [first, second, third] = a.mock.calls.map((c) => c[0] as Record<string, unknown>)
    expect(first!.version).toEqual({ serial: 's', timestamp: 5 })
    expect(second!.serial).toBe('agent-bridge-2')
    expect(second!.version).toEqual({ serial: second!.serial, timestamp: second!.timestamp })
    expect(third).not.toHaveProperty('event')
  })

  test('rejects "event", which Ably messages do not have', async () => {
    const { tools, channel } = setup()
    await channel('chat').subscribe(mock())
    expect(() => run(tools, 'realtime.emit', 'chat', { event: 'typing' })).toThrow('"name", not "event"')
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
