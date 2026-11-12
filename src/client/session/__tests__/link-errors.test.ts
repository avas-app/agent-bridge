import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { SessionLinkError, openSessionLink } from '../client'
import type { SessionState } from '../state'

test('a failed connect to a session socket rejects without an uncaught error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-link-'))
  const uncaught: unknown[] = []
  const onUncaught = (error: unknown) => uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  try {
    const state = { name: 'gone', socket: join(dir, 'gone.sock') } as SessionState
    await expect(openSessionLink(state)).rejects.toBeInstanceOf(SessionLinkError)
    await new Promise((r) => setTimeout(r, 50))
    expect(uncaught).toEqual([])
  } finally {
    process.off('uncaughtException', onUncaught)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reset after connect settles the pending request with linkLost and the reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-link-'))
  const uncaught: unknown[] = []
  const onUncaught = (error: unknown) => uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  const socketPath = join(dir, 'reset.sock')
  // Destroying with the client's request unread makes the kernel reset the peer.
  const server = createServer((socket) => {
    socket.on('error', () => {})
    socket.pause()
    setTimeout(() => socket.destroy(), 50)
  })
  await new Promise<void>((r) => server.listen(socketPath, r))
  try {
    const link = await openSessionLink({ name: 'reset', socket: socketPath } as SessionState)
    const res = await link.request({ op: 'call', tool: 'big', args: ['x'.repeat(5_000_000)] })
    expect(res.linkLost).toBe(true)
    expect(res.error).toContain('closed the connection: ')
    expect(res.error).toContain('ECONNRESET')
    await new Promise((r) => setTimeout(r, 50))
    expect(uncaught).toEqual([])
  } finally {
    process.off('uncaughtException', onUncaught)
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
