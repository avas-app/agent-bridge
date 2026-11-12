import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
