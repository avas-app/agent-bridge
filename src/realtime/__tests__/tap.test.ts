import { describe, expect, mock, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { createRealtimeTap, type RealtimeConnection } from '../tap'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

type Message = { id?: string; event: string; payload: unknown }

// A stand-in for an app's realtime client: one handler list per channel.
function fakeClient() {
  const handlers = new Map<string, Set<(m: Message) => void>>()
  return {
    subscribe(channel: string, handler: (m: Message) => void) {
      if (!handlers.has(channel)) handlers.set(channel, new Set())
      handlers.get(channel)!.add(handler)
      return () => handlers.get(channel)!.delete(handler)
    },
    deliver(channel: string, message: Message) {
      for (const h of handlers.get(channel) ?? []) h(message)
    },
  }
}

function setup(options: Parameters<typeof createRealtimeTap<Message>>[0] = {}) {
  const client = fakeClient()
  const tap = createRealtimeTap<Message>({
    describe: (m) => ({ event: m.event, data: m.payload, id: m.id }),
    toMessage: ([event, payload], { id }) => ({ id, event: event as string, payload }),
    ...options,
  })
  // The app's own subscribe layer, adopting the tap in two lines.
  const subscribe = (channel: string, onMessage: (m: Message) => void) => {
    const { listener, unsubscribe } = tap.wrap(channel, onMessage)
    const off = client.subscribe(channel, listener)
    return () => {
      off()
      unsubscribe()
    }
  }
  return { client, tap, tools: tap.tools, subscribe }
}

describe('createRealtimeTap', () => {
  test('passes real messages through and logs each once, however many listeners get it', () => {
    const { client, tools, subscribe } = setup()
    const a = mock()
    const b = mock()
    subscribe('chat', a)
    subscribe('chat', b)

    client.deliver('chat', { id: 'm1', event: 'typing', payload: { user: 'sam' } })

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(run(tools, 'realtime.log')).toEqual([
      expect.objectContaining({
        channel: 'chat',
        event: 'typing',
        data: { user: 'sam' },
        id: 'm1',
        injected: false,
      }),
    ])
  })

  test('logs a repeated message again when it arrives again', () => {
    const { client, tools, subscribe } = setup()
    subscribe('chat', mock())
    subscribe('chat', mock())
    const message = { event: 'ping', payload: 1 }
    client.deliver('chat', message)
    client.deliver('chat', message)
    expect(run(tools, 'realtime.log')).toHaveLength(2)
  })

  test('emit delivers through the app handlers and names live channels when nothing listens', () => {
    const { tools, subscribe } = setup()
    const a = mock()
    const b = mock()
    const other = mock()
    subscribe('order-1', a)
    subscribe('order-1', b)
    subscribe('presence', other)

    const result = run(tools, 'realtime.emit', 'order-1', 'status', { status: 'arrived' })

    expect(result).toEqual({ id: 'agent-bridge-1', delivered: 2 })
    expect(a).toHaveBeenCalledWith({ id: 'agent-bridge-1', event: 'status', payload: { status: 'arrived' } })
    expect(b).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    expect(run(tools, 'realtime.log', { event: 'status' })).toEqual([
      expect.objectContaining({ channel: 'order-1', injected: true, id: 'agent-bridge-1' }),
    ])
    expect(() => run(tools, 'realtime.emit', 'nope', 'x')).toThrow(
      'Live channels: order-1, presence',
    )
  })

  test('emit skips listeners that would not get the message', () => {
    const { tap, tools } = setup()
    const typing = mock()
    const all = mock()
    tap.wrap('chat', typing, { accepts: (m) => m.event === 'typing' })
    tap.wrap('chat', all)
    expect(run(tools, 'realtime.emit', 'chat', 'message', 'hi')).toMatchObject({ delivered: 1 })
    expect(typing).not.toHaveBeenCalled()
    expect(all).toHaveBeenCalledTimes(1)
  })

  test('mute drops real messages but not injected ones, until unmute or restore', () => {
    const { client, tools, subscribe } = setup()
    const a = mock()
    subscribe('chat', a)

    expect(run(tools, 'realtime.mute', 'chat')).toEqual({ muted: ['chat'] })
    client.deliver('chat', { event: 'message', payload: 'real' })
    expect(a).not.toHaveBeenCalled()
    run(tools, 'realtime.emit', 'chat', 'message', 'fake')
    expect(a).toHaveBeenCalledTimes(1)

    expect(run(tools, 'realtime.restore')).toEqual({ unmuted: ['chat'], connectionFaked: false })
    client.deliver('chat', { event: 'message', payload: 'real again' })
    expect(a).toHaveBeenCalledTimes(2)

    const log = run(tools, 'realtime.log') as Array<{ data: unknown; dropped?: string }>
    expect(log.map((e) => [e.data, e.dropped])).toEqual([
      ['real again', undefined],
      ['fake', undefined],
      ['real', 'muted'],
    ])
  })

  test('mute with dropInjected drops injected messages too; "*" mutes every channel', () => {
    const { client, tools, subscribe } = setup()
    const a = mock()
    const b = mock()
    subscribe('chat', a)
    subscribe('presence', b)

    run(tools, 'realtime.mute', '*', { dropInjected: true })
    expect(run(tools, 'realtime.emit', 'chat', 'message', 'x')).toMatchObject({ delivered: 0 })
    client.deliver('presence', { event: 'enter', payload: null })
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
    expect(run(tools, 'realtime.channels')).toEqual([
      { name: 'chat', listeners: 1, muted: true },
      { name: 'presence', listeners: 1, muted: true },
    ])

    run(tools, 'realtime.unmute', '*')
    client.deliver('presence', { event: 'enter', payload: null })
    expect(b).toHaveBeenCalledTimes(1)
  })

  test('forgets a listener once the app unsubscribes', () => {
    const { tools, subscribe } = setup({ channelInfo: () => ({ state: 'attached' }) })
    const off = subscribe('chat', mock())
    expect(run(tools, 'realtime.channels')).toEqual([
      { name: 'chat', listeners: 1, muted: false, state: 'attached' },
    ])
    off()
    expect(run(tools, 'realtime.channels')).toEqual([])
    expect(() => run(tools, 'realtime.emit', 'chat', 'x')).toThrow('Nothing listens on "chat"')
  })

  test('keeps the last 50 messages; log filters, limits and clears', () => {
    const { client, tools, subscribe } = setup()
    subscribe('chat', mock())
    for (let i = 0; i < 60; i++) client.deliver('chat', { event: 'n', payload: i })
    const all = run(tools, 'realtime.log', { limit: 100 }) as Array<{ data: number }>
    expect(all).toHaveLength(50)
    expect(all[0]!.data).toBe(59)
    expect(run(tools, 'realtime.log', { limit: 2, clear: true })).toHaveLength(2)
    expect(run(tools, 'realtime.log')).toEqual([])
  })

  test('namespace renames the tools', () => {
    const { tools } = setup({ namespace: 'chat' })
    expect(Object.keys(tools).sort()).toEqual([
      'chat.channels',
      'chat.emit',
      'chat.log',
      'chat.mute',
      'chat.restore',
      'chat.unmute',
    ])
  })

  test('fakes connection states, drops real messages while not live, and restores', () => {
    let real = 'connected'
    const fake = mock<RealtimeConnection['fake']>()
    const { client, tools, subscribe } = setup({
      connection: { state: () => real, fake, states: ['connected', 'disconnected'] },
    })
    const a = mock()
    subscribe('chat', a)

    expect(run(tools, 'realtime.connection')).toEqual({ state: 'connected', real: 'connected', faked: false })
    run(tools, 'realtime.connection', 'disconnected')
    expect(fake).toHaveBeenLastCalledWith('disconnected', 'connected')
    expect(() => run(tools, 'realtime.connection', 'gone')).toThrow('Known: connected, disconnected')

    client.deliver('chat', { event: 'message', payload: 'real' })
    run(tools, 'realtime.emit', 'chat', 'message', 'fake')
    expect(a.mock.calls.map(([m]) => (m as Message).payload)).toEqual(['fake'])
    expect(run(tools, 'realtime.log', { limit: 1, event: 'message' })).toEqual([
      expect.objectContaining({ data: 'fake' }),
    ])

    real = 'connecting'
    expect(run(tools, 'realtime.restore')).toEqual({ unmuted: [], connectionFaked: true })
    expect(fake).toHaveBeenLastCalledWith(null, 'disconnected')
    expect(run(tools, 'realtime.connection')).toEqual({ state: 'connecting', real: 'connecting', faked: false })
  })
})
