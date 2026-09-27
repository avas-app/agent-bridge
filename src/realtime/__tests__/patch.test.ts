import { describe, expect, mock, test } from 'bun:test'

import type { ToolFn, Tools } from '../../runtime/types'
import { fakeableConnection, realtimeAdapter, tapListeners } from '../patch'
import { createRealtimeTap } from '../tap'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

type Callback = (data: unknown, metadata?: { user_id?: string }) => void

// A Pusher-style channel: bind(event, fn) / unbind(event?, fn?), with a
// second argument the tap must pass through.
function fakeChannel(name: string) {
  const binds: Array<{ event: string; fn: Callback }> = []
  return {
    name,
    bind(event: string, fn: Callback) {
      binds.push({ event, fn })
    },
    unbind(event?: string, fn?: Callback) {
      for (const b of [...binds])
        if ((!event || b.event === event) && (!fn || b.fn === fn)) binds.splice(binds.indexOf(b), 1)
    },
    deliver(event: string, data: unknown, metadata?: { user_id?: string }) {
      for (const b of binds.filter((b) => b.event === event)) b.fn(data, metadata)
    },
  }
}

// The whole adapter an app would write.
const channelTools = realtimeAdapter((channel: ReturnType<typeof fakeChannel>, _options: object) => {
  const tap = createRealtimeTap<unknown>()
  tapListeners(tap, channel, {
    add: 'bind',
    remove: 'unbind',
    channel: ([event]) => `${channel.name}:${event}`,
  })
  return tap
})

describe('tapListeners', () => {
  test('makes a custom adapter in a few lines, passing extra listener arguments through', () => {
    const channel = fakeChannel('room')
    const tools = channelTools(channel)
    expect(channelTools(channel)).toBe(tools)
    const a = mock()
    channel.bind('message', a)

    channel.deliver('message', { text: 'hi' }, { user_id: 'u1' })
    expect(a).toHaveBeenCalledWith({ text: 'hi' }, { user_id: 'u1' })

    expect(run(tools, 'realtime.emit', 'room:message', { text: 'fake' })).toMatchObject({ delivered: 1 })
    expect(a).toHaveBeenLastCalledWith({ text: 'fake' })

    run(tools, 'realtime.mute', 'room:message')
    channel.deliver('message', 'dropped')
    expect(a).toHaveBeenCalledTimes(2)

    channel.unbind('message', a)
    expect(run(tools, 'realtime.channels')).toEqual([])
    channel.deliver('message', 'gone')
    expect(a).toHaveBeenCalledTimes(2)
  })

  test('removes by key alone, and passes through calls it leaves alone', () => {
    const channel = fakeChannel('room')
    const tap = createRealtimeTap()
    tapListeners(tap, channel, {
      add: 'bind',
      remove: 'unbind',
      channel: ([event]) => (event === 'internal' ? undefined : String(event)),
    })
    const internal = mock()
    channel.bind('internal', internal)
    channel.bind('a', mock())
    channel.bind('a', mock())
    channel.bind('b', mock())
    expect(run(tap.tools, 'realtime.channels')).toMatchObject([
      { name: 'a', listeners: 2 },
      { name: 'b', listeners: 1 },
    ])

    channel.unbind('a')
    expect(run(tap.tools, 'realtime.channels')).toMatchObject([{ name: 'b' }])
    channel.deliver('internal', 1)
    expect(internal).toHaveBeenCalledWith(1, undefined)
    channel.unbind()
    expect(run(tap.tools, 'realtime.channels')).toEqual([])
  })
})

describe('fakeableConnection', () => {
  test('fakes the state property and silences real announcements until it goes back', () => {
    const heard: unknown[][] = []
    const client = {
      status: 'online',
      announce(...args: unknown[]) {
        heard.push(args)
      },
    }
    const connection = fakeableConnection(client, {
      property: 'status',
      events: 'announce',
      states: ['online', 'offline'],
      live: 'online',
      announce: (emit, { current, previous }) => emit(current, previous),
    })!
    const tap = createRealtimeTap({ connection })

    run(tap.tools, 'realtime.connection', 'offline')
    expect(client.status).toBe('offline')
    expect(heard).toEqual([['offline', 'online']])

    // The client's own change while faked: stored, not announced.
    client.status = 'online'
    client.announce('online')
    expect(heard).toHaveLength(1)

    run(tap.tools, 'realtime.restore')
    expect(client.status).toBe('online')
    expect(heard).toEqual([['offline', 'online'], ['online', 'offline']])
  })

  test('is undefined when the client has no events method', () => {
    expect(
      fakeableConnection({ status: 'x' }, { property: 'status', events: 'emit', states: [], announce: () => {} }),
    ).toBeUndefined()
    expect(fakeableConnection(undefined, { property: 'status', events: 'emit', states: [], announce: () => {} })).toBeUndefined()
  })
})
