import { afterEach, describe, expect, mock, test } from 'bun:test'
import { io, type Socket } from 'socket.io-client'

import type { ToolFn, Tools } from '../../runtime/types'
import { socketIoTools } from '../socket-io'

const run = (tools: Tools, name: string, ...args: unknown[]) => {
  const t = tools[name]
  if (!t) throw new Error(`missing ${name}`)
  return (typeof t === 'function' ? t : (t.run as ToolFn))(...args)
}

// socket.io packet types: CONNECT 0, DISCONNECT 1, EVENT 2.
type Packet = { type: number; nsp: string; data?: unknown; id?: number }

// A real socket that never opens a transport; tests play the server's packets.
const sockets: Socket[] = []
function setup() {
  const socket = io('http://localhost:1', { autoConnect: false })
  sockets.push(socket)
  const tools = socketIoTools(socket)
  const receive = (packet: Omit<Packet, 'nsp'>) =>
    (socket as unknown as { onpacket: (p: Packet) => void }).onpacket({ nsp: '/', ...packet })
  const connect = () => receive({ type: 0, data: { sid: 'sid-1' } })
  const event = (...data: unknown[]) => receive({ type: 2, data })
  return { socket, tools, connect, receive, event }
}

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.io.engine?.close()
})

describe('socketIoTools', () => {
  test('logs real events once and injects arguments into every listener', () => {
    const { socket, tools, connect, event } = setup()
    connect()
    const a = mock()
    const b = mock()
    socket.on('chat', a)
    socket.on('chat', b)

    event('chat', { text: 'hi' }, 2)
    expect(a).toHaveBeenCalledWith({ text: 'hi' }, 2)
    expect(b).toHaveBeenCalledTimes(1)

    expect(run(tools, 'realtime.emit', 'chat', { text: 'fake' })).toEqual({ delivered: 2 })
    expect(a).toHaveBeenLastCalledWith({ text: 'fake' })

    expect(run(tools, 'realtime.log')).toEqual([
      expect.objectContaining({ channel: 'chat', data: { text: 'fake' }, injected: true }),
      expect.objectContaining({ channel: 'chat', data: [{ text: 'hi' }, 2], injected: false }),
    ])
    expect(run(tools, 'realtime.channels')).toEqual([{ name: 'chat', listeners: 2, muted: false }])
  })

  test('leaves the ack callback out of the log', () => {
    const { socket, tools, connect, receive } = setup()
    connect()
    const a = mock()
    socket.on('order', a)
    receive({ type: 2, id: 7, data: ['order', { id: 'o1' }] })
    expect(a).toHaveBeenCalledWith({ id: 'o1' }, expect.any(Function))
    expect(run(tools, 'realtime.log')).toEqual([expect.objectContaining({ data: { id: 'o1' } })])
  })

  test('mute drops real events; off and once keep the channel list right', () => {
    const { socket, tools, connect, event } = setup()
    connect()
    const a = mock()
    const once = mock()
    socket.on('chat', a)
    socket.once('chat', once)
    expect(run(tools, 'realtime.channels')).toMatchObject([{ name: 'chat', listeners: 2 }])

    run(tools, 'realtime.mute', 'chat')
    event('chat', 'real')
    expect(a).not.toHaveBeenCalled()
    expect(once).not.toHaveBeenCalled()
    run(tools, 'realtime.unmute', 'chat')

    event('chat', 'again')
    expect(once).toHaveBeenCalledTimes(1)
    expect(run(tools, 'realtime.channels')).toMatchObject([{ name: 'chat', listeners: 1 }])

    socket.once('chat', once)
    socket.off('chat', once)
    socket.off('chat', a)
    event('chat', 'gone')
    expect(a).toHaveBeenCalledTimes(1)
    expect(once).toHaveBeenCalledTimes(1)
    expect(run(tools, 'realtime.channels')).toEqual([])
  })

  test('leaves lifecycle events alone and patches a socket only once', () => {
    const { socket, tools, connect } = setup()
    const onConnect = mock()
    socket.on('connect', onConnect)
    connect()
    expect(onConnect).toHaveBeenCalledTimes(1)
    expect(run(tools, 'realtime.channels')).toEqual([])
    expect(socketIoTools(socket)).toBe(tools)
  })

  test('fakes a disconnect, drops real events meanwhile, and reconnects on restore', () => {
    const { socket, tools, connect, event, receive } = setup()
    connect()
    const onConnect = mock()
    const onDisconnect = mock()
    const a = mock()
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('chat', a)

    run(tools, 'realtime.connection', 'disconnected')
    expect(onDisconnect).toHaveBeenCalledWith('transport close')
    // socket.io buffers events while `connected` is false, so it stays real:
    // a real event reaches the tap, is logged as dropped, and never replays.
    expect(socket.connected).toBe(true)
    event('chat', 'real')
    expect(a).not.toHaveBeenCalled()
    expect(run(tools, 'realtime.log', { limit: 1 })).toEqual([
      expect.objectContaining({ data: 'real', dropped: 'connection' }),
    ])
    run(tools, 'realtime.emit', 'chat', 'fake')
    expect(a).toHaveBeenCalledWith('fake')

    // A real disconnect while faked: the app hears nothing, the real state follows.
    receive({ type: 1 })
    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(run(tools, 'realtime.connection')).toEqual({ state: 'disconnected', real: 'disconnected', faked: true })

    run(tools, 'realtime.connection', 'connected')
    expect(onConnect).toHaveBeenCalledTimes(1)
    run(tools, 'realtime.restore')
    expect(socket.connected).toBe(false)
    expect(onDisconnect).toHaveBeenCalledTimes(2)
    expect(a.mock.calls).toEqual([['fake']])
  })
})
