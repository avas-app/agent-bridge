import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { readCommit, readDials } from '../../session/dials-store'
import { encodeLine } from '../../session/protocol'
import type { SessionRequest } from '../../session/protocol'
import type { SessionState } from '../../session/state'
import { dialsCommand, panelKey } from '../cli'
import { createDialsServer } from '../server'

let dir = ''
const closers: Array<() => unknown> = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dials-v2-'))
})
afterEach(async () => {
  process.exitCode = 0
  while (closers.length) await closers.pop()?.()
  rmSync(dir, { recursive: true, force: true })
})

const PNG = Buffer.from('fake-png').toString('base64')

/** A session whose app answers the v2 dial tools; `calls` logs every tool call in order. */
async function fakeSession(options: { capture?: boolean } = {}) {
  const calls: Array<[string, unknown[]]> = []
  const saveFlags: Array<boolean | undefined> = []
  let failSet = false
  let tile = 'roomy'
  const socket = join(dir, 'app.sock')
  const server: Server = createServer((conn) => {
    conn.on('error', () => {})
    createInterface({ input: conn }).on('line', (line) => {
      const req = JSON.parse(line) as SessionRequest
      const args = req.args ?? []
      calls.push([req.tool ?? '', args])
      if (req.tool === 'dial.set') saveFlags.push(req.save)
      const ok = (v: unknown) => ({ id: req.id, result: { id: '', from: '', ok: true, value: v, ms: 0 } })
      const fail = (e: string) => ({ id: req.id, result: { id: '', from: '', ok: false, error: e, ms: 0 } })
      let res: unknown
      switch (req.tool) {
        case 'dial.list':
          res = ok([
            { id: 'card.accent', type: 'color', value: '#222', original: '#111' },
            { id: 'card.layout', type: 'variant', value: tile, original: 'roomy', options: ['roomy', 'tiles'] },
          ])
          break
        case 'dial.tokens':
          res = ok({ tokens: { colors: { brand: '#0af' } }, labels: { 'colors.brand': 'Brand' } })
          break
        case 'dial.highlight':
          res = ok({ rects: [] })
          break
        case 'dial.rects':
          res = ok({ rects: [{ x: 10, y: 20, width: 100, height: 50 }], scale: 3, window: { width: 400, height: 800 } })
          break
        case 'dial.set':
          if (failSet && args[1] === '#111') {
            res = fail('boom')
            break
          }
          if (args[0] === 'card.layout') tile = String(args[1])
          res = ok({})
          break
        case 'screen.capture':
          res = options.capture ? ok({ base64: PNG }) : fail('needs react-native-view-shot')
          break
        default:
          res = { id: req.id, error: 'nope' }
      }
      conn.write(encodeLine(res))
    })
  })
  await new Promise<void>((r) => server.listen(socket, r))
  closers.push(() => server.close())
  const state: SessionState = {
    name: 'app',
    pid: process.pid,
    socket,
    metro: 'localhost:8081',
    project: dir,
    device: { name: 'Phone', deviceId: 'app', platform: 'ios' },
    transport: 'expo',
    startedAt: 1,
    lastCallAt: 1,
    idleMs: 0,
  }
  return { state, calls, saveFlags, failOnOriginal: () => void (failSet = true), tool: (name: string) => calls.filter(([t]) => t === name) }
}

async function start(session: SessionState, extra: Parameters<typeof createDialsServer>[0] = {}) {
  const panel = createDialsServer({ project: dir, key: 'k', sessions: () => [session], ...extra })
  closers.push(panel.close)
  const { port } = await panel.listen()
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}?key=k`, { method: 'POST', body: JSON.stringify(body) })
  return { panel, port, post, get: (path: string) => fetch(`http://127.0.0.1:${port}${path}?key=k`) }
}

describe('snapshot', () => {
  test('carries labels, the token tree, source per dial and the capture flag', async () => {
    writeFileSync(join(dir, 'App.tsx'), "const c = dial.color('card.accent', '#111')\n")
    const app = await fakeSession({ capture: true })
    const { get } = await start(app.state)
    const snap = (await (await get('/api/dials')).json()) as {
      tokens: unknown
      labels: Record<string, string>
      dials: Array<{ id: string; source?: { file: string; line: number } }>
      capture: boolean
      commit: unknown
    }
    expect(snap.tokens).toEqual({ colors: { brand: '#0af' } })
    expect(snap.labels).toEqual({ 'colors.brand': 'Brand' })
    expect(snap.dials.find((d) => d.id === 'card.accent')?.source).toEqual({ file: 'App.tsx', line: 1 })
    expect(snap.dials.find((d) => d.id === 'card.layout')?.source).toBeUndefined()
    expect(snap.capture).toBe(true)
    expect(snap.commit).toBeNull()
  })
})

describe('highlight and capture', () => {
  test('/api/highlight fans out dial.highlight, null clears', async () => {
    const app = await fakeSession()
    const { post } = await start(app.state)
    await post('/api/highlight', { id: 'card.accent' })
    await post('/api/highlight', { id: null })
    expect(app.tool('dial.highlight').map(([, a]) => a)).toEqual([['card.accent'], [null]])
  })

  test('/api/capture clears the outline, shoots, reads rects, restores the outline', async () => {
    const app = await fakeSession({ capture: true })
    const { post } = await start(app.state)
    await post('/api/highlight', { id: 'card.accent' })
    app.calls.length = 0
    const body = (await (await post('/api/capture', { id: 'card.accent' })).json()) as {
      results: Array<{ device: string; png: string; rect: unknown; scale: number }>
    }
    expect(body.results[0]).toMatchObject({
      device: 'Phone',
      png: `data:image/jpeg;base64,${PNG}`,
      rect: { x: 10, y: 20, width: 100, height: 50 },
      scale: 3,
    })
    expect(app.calls.map(([t, a]) => (t === 'dial.highlight' ? `${t}:${a[0]}` : t))).toEqual([
      'dial.highlight:null',
      'dial.rects',
      'screen.capture',
      'dial.highlight:card.accent',
    ])
  })

  test('falls back to the screenshot command and deletes its temp file', async () => {
    const app = await fakeSession()
    const marker = join(dir, 'last-out')
    const cmd = `printf cmd-png > {out}; printf %s {out} > '${marker}'`
    const { post } = await start(app.state, { screenshotCmd: cmd })
    const body = (await (await post('/api/capture', { id: 'card.accent' })).json()) as {
      results: Array<{ png?: string }>
    }
    expect(Buffer.from(body.results[0]!.png!, 'base64').toString()).toBe('cmd-png')
    const out = (await Bun.file(marker).text()).trim()
    expect(existsSync(out)).toBe(false)
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('dials-shot-') && out.includes(n))).toEqual([])
  })

  test('says so when there is no screenshot source', async () => {
    const app = await fakeSession()
    const { post } = await start(app.state)
    const body = (await (await post('/api/capture', { id: 'card.accent' })).json()) as {
      results: Array<{ error?: string }>
    }
    expect(body.results[0]?.error).toBe('no screenshot source')
  })

  test('/api/capture-variants sets each option, captures it, then puts the value back', async () => {
    const app = await fakeSession({ capture: true })
    const { post } = await start(app.state, { renderWaitMs: 0 })
    const body = (await (await post('/api/capture-variants', { id: 'card.layout' })).json()) as Record<
      string,
      { png: string }
    >
    expect(Object.keys(body)).toEqual(['roomy', 'tiles'])
    expect(body.tiles?.png).toBe(`data:image/jpeg;base64,${PNG}`)
    expect(app.tool('dial.set').map(([, a]) => a)).toEqual([
      ['card.layout', 'roomy'],
      ['card.layout', 'tiles'],
      ['card.layout', 'roomy'],
    ])
  })

  test('capture-variants and set with save:false never ask the daemon to save (13)', async () => {
    const app = await fakeSession({ capture: true })
    const { post } = await start(app.state, { renderWaitMs: 0 })
    await post('/api/capture-variants', { id: 'card.layout' })
    expect(app.saveFlags).toEqual([false, false, false])
    app.saveFlags.length = 0
    await post('/api/dials/set', { id: 'card.accent', value: '#111', save: false })
    await post('/api/dials/set', { id: 'card.accent', value: '#333' })
    expect(app.saveFlags).toEqual([false, undefined])
  })

  test('routes need the key', async () => {
    const app = await fakeSession()
    const { port } = await start(app.state)
    for (const path of ['/api/highlight', '/api/capture', '/api/capture-variants', '/api/commit'])
      expect((await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: '{}' })).status).toBe(401)
  })
})

describe('commit round trip', () => {
  test('request -> dials wait takes it -> commit-status updates it, dials clear keeps it', async () => {
    writeFileSync(join(dir, 'App.tsx'), "dial.color('card.accent', '#111')\n")
    const app = await fakeSession()
    const { post, get } = await start(app.state)
    expect((await post('/api/commit', { ids: [] })).status).toBe(400)
    expect((await post('/api/commit', { ids: ['nope'] })).status).toBe(400)
    const res = (await (await post('/api/commit', { ids: ['card.accent'], note: 'ship it', revertOthers: true })).json()) as {
      commit: { id: string }
    }
    expect(readCommit(dir)).toMatchObject({
      id: res.commit.id,
      status: 'requested',
      note: 'ship it',
      revertOthers: true,
      values: { 'card.accent': { value: '#222', original: '#111', type: 'color', source: { file: 'App.tsx', line: 1 } } },
    })
    expect(((await (await get('/api/dials')).json()) as { commit: { status: string } }).commit.status).toBe('requested')

    const logs: string[] = []
    const log = console.log
    console.log = (m: string) => void logs.push(m)
    try {
      await dialsCommand('wait', [], { json: true, timeout: '2' }, async () => {}, dir)
      expect(JSON.parse(logs[0]!)).toMatchObject({ id: res.commit.id, status: 'taken' })
      expect(readCommit(dir)?.status).toBe('taken')
      await dialsCommand('commit-status', ['failed'], { message: 'conflict' }, async () => {}, dir)
      expect(readCommit(dir)).toMatchObject({ status: 'failed', message: 'conflict' })
      await dialsCommand('commit-status', ['done'], {}, async () => {}, dir)
      expect(readCommit(dir)?.message).toBeUndefined()
      await dialsCommand('clear', [], {}, async () => {}, dir)
      expect(readCommit(dir)?.status).toBe('done')
      expect(readDials(dir)).toEqual({})
    } finally {
      console.log = log
    }
  })

  test('a second commit is refused (409) while one is in flight, and allowed after a cancel (4)', async () => {
    const app = await fakeSession()
    const { post } = await start(app.state)
    const first = (await (await post('/api/commit', { ids: ['card.accent'] })).json()) as { commit: { id: string } }
    const second = await post('/api/commit', { ids: ['card.accent'] })
    expect(second.status).toBe(409)
    expect(readCommit(dir)?.id).toBe(first.commit.id)
    expect((await post('/api/commit-cancel', {})).status).toBe(200)
    expect(readCommit(dir)?.status).toBe('cancelled')
    expect((await post('/api/commit', { ids: ['card.accent'] })).status).toBe(200)
  })

  test('commit-status checks the id and the status; dials cancel stops a stuck request', async () => {
    const app = await fakeSession()
    const { post } = await start(app.state)
    const { commit } = (await (await post('/api/commit', { ids: ['card.accent'] })).json()) as { commit: { id: string } }
    const run = (status: string, flags = {}, rest: string[] = []) =>
      dialsCommand('commit-status', [status, ...rest], flags, async () => {}, dir)
    // Not taken yet: only a cancel is allowed.
    await expect(run('done')).rejects.toThrow('not been taken')
    await dialsCommand('wait', [], { json: true, timeout: '2' }, async () => {}, dir).catch(() => {})
    await expect(run('writing', {}, ['not-the-id'])).rejects.toThrow('different commit')
    await run('writing', {}, [commit.id.slice(0, 8)])
    expect(readCommit(dir)?.status).toBe('writing')
    await dialsCommand('cancel', [], {}, async () => {}, dir)
    expect(readCommit(dir)?.status).toBe('cancelled')
    await expect(run('done')).rejects.toThrow('cancelled')
  })

  test('dials wait exits 2 on timeout and ignores a commit that is already taken', async () => {
    const err = console.error
    console.error = () => {}
    try {
      await dialsCommand('wait', [], { timeout: '0' }, async () => {}, dir)
      expect(process.exitCode).toBe(2)
    } finally {
      console.error = err
    }
  })

  test('commit-status rejects a bad status and a missing commit', async () => {
    await expect(dialsCommand('commit-status', ['nope'], {}, async () => {}, dir)).rejects.toThrow('Usage')
    await expect(dialsCommand('commit-status', ['done'], {}, async () => {}, dir)).rejects.toThrow('No commit')
  })
})

describe('panel key', () => {
  test('is kept across restarts, private, and replaced on request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dials-key-'))
    try {
      const a = panelKey(dir)
      expect(a).toMatch(/^[0-9a-f]{32}$/)
      expect(panelKey(dir)).toBe(a)
      expect(statSync(join(dir, '.agent-bridge', 'dials-key')).mode & 0o777).toBe(0o600)
      const b = panelKey(dir, true)
      expect(b).not.toBe(a)
      expect(panelKey(dir)).toBe(b)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
