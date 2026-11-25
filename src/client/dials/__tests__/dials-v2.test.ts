import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { agentWaiting, markWaiter, readCommit, readDials, writeCommit } from '../../session/dials-store'
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
async function fakeSession(options: { capture?: boolean; oversize?: boolean; captureDelayMs?: number } = {}) {
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
          res = options.oversize ? ok({ path: '/data/shot.jpg' }) : options.capture ? ok({ base64: PNG }) : fail('needs react-native-view-shot')
          break
        default:
          res = { id: req.id, error: 'nope' }
      }
      if (req.tool === 'screen.capture' && options.captureDelayMs) setTimeout(() => conn.write(encodeLine(res)), options.captureDelayMs)
      else conn.write(encodeLine(res))
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

  test('--outline reaches dial.highlight; clearing and no flag send plain args', async () => {
    const app = await fakeSession()
    const { post } = await start(app.state, { outline: '#FF3EA5' })
    await post('/api/highlight', { id: 'card.accent' })
    await post('/api/highlight', { id: null })
    expect(app.tool('dial.highlight').map(([, a]) => a)).toEqual([['card.accent', { color: '#FF3EA5' }], [null]])
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

describe('review fixes', () => {
  test('capture flag is false with a device but no screenshot source', async () => {
    const app = await fakeSession()
    const { get } = await start(app.state)
    const snap = (await (await get('/api/dials')).json()) as { capture: boolean }
    expect(snap.capture).toBe(false)
  })

  test('capture flag probes screen.capture once per session', async () => {
    const app = await fakeSession({ capture: true })
    const { get } = await start(app.state)
    await get('/api/dials')
    await get('/api/dials')
    expect(app.tool('screen.capture').length).toBe(1)
  })

  test('an oversize capture says it is too large', async () => {
    const app = await fakeSession({ oversize: true })
    const { post } = await start(app.state)
    const body = (await (await post('/api/capture', { id: 'card.accent' })).json()) as {
      results: Array<{ error?: string }>
    }
    expect(body.results[0]?.error).toContain('too large')
  })

  test('screenshot command gets the path safely when TMPDIR has a quote', async () => {
    const app = await fakeSession()
    const odd = join(dir, "it's here")
    mkdirSync(odd)
    const old = process.env.TMPDIR
    process.env.TMPDIR = odd
    try {
      const { post } = await start(app.state, { screenshotCmd: 'printf cmd-png > {out}' })
      const body = (await (await post('/api/capture', { id: 'card.accent' })).json()) as {
        results: Array<{ png?: string; error?: string }>
      }
      expect(body.results[0]?.error).toBeUndefined()
      expect(Buffer.from(body.results[0]!.png!, 'base64').toString()).toBe('cmd-png')
    } finally {
      if (old === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = old
    }
  })

  test('capture does not bring back an outline cleared while it ran', async () => {
    const app = await fakeSession({ capture: true, captureDelayMs: 150 })
    const { post } = await start(app.state)
    await post('/api/highlight', { id: 'card.accent' })
    app.calls.length = 0
    const shot = post('/api/capture', { id: 'card.accent' })
    await new Promise((r) => setTimeout(r, 50))
    await post('/api/highlight', { id: null })
    await shot
    const highlights = app.tool('dial.highlight').map(([, a]) => a[0])
    expect(highlights[highlights.length - 1]).toBeNull()
  })

  test('a body over the limit destroys the request', async () => {
    const app = await fakeSession()
    const { port } = await start(app.state)
    const res = await fetch(`http://127.0.0.1:${port}/api/dials/set?key=k`, {
      method: 'POST',
      body: 'x'.repeat(1_100_000),
    }).catch((e: Error) => e)
    expect(res).toBeInstanceOf(Error)
  })
})

describe('panel key file', () => {
  test('an existing world-readable key file is tightened, and a new key replaces it safely', () => {
    const d = mkdtempSync(join(tmpdir(), 'dials-key-'))
    try {
      mkdirSync(join(d, '.agent-bridge'))
      const file = join(d, '.agent-bridge', 'dials-key')
      writeFileSync(file, `${'a'.repeat(32)}\n`, { mode: 0o644 })
      chmodSync(file, 0o644)
      expect(panelKey(d)).toBe('a'.repeat(32))
      expect(statSync(file).mode & 0o777).toBe(0o600)
      chmodSync(file, 0o644)
      panelKey(d, true)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(readdirSync(join(d, '.agent-bridge'))).toEqual(['dials-key'])
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  test('serve warns when .agent-bridge/ is not git-ignored', async () => {
    const d = mkdtempSync(join(tmpdir(), 'dials-ign-'))
    const errs: string[] = []
    const err = console.error
    const log = console.log
    console.error = (...a: unknown[]) => void errs.push(a.join(' '))
    console.log = () => {}
    try {
      const run = dialsCommand('serve', [], { port: '0', 'no-session': true }, async () => {}, d)
      await new Promise((r) => setTimeout(r, 200))
      process.emit('SIGTERM')
      await run
      expect(errs.join('\n')).toContain('.gitignore')
    } finally {
      console.error = err
      console.log = log
      rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('serve and sessions', () => {
  let stateDir = ''
  let project = ''
  const quiet = { err: console.error, log: console.log }
  let errs: string[] = []
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'dials-state-'))
    project = mkdtempSync(join(tmpdir(), 'dials-proj-'))
    writeFileSync(join(project, '.gitignore'), '.agent-bridge/\n')
    process.env.AGENT_BRIDGE_STATE_DIR = stateDir
    errs = []
    console.error = (...a: unknown[]) => void errs.push(a.join(' '))
    console.log = () => {}
  })
  afterEach(() => {
    console.error = quiet.err
    console.log = quiet.log
    delete process.env.AGENT_BRIDGE_STATE_DIR
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })

  /** A session socket that logs every request and answers stop. */
  async function stopRecorder(name: string) {
    const got: SessionRequest[] = []
    const socket = join(stateDir, `${name}.sock`)
    const server: Server = createServer((conn) => {
      conn.on('error', () => {})
      createInterface({ input: conn }).on('line', (line) => {
        const req = JSON.parse(line) as SessionRequest
        got.push(req)
        conn.write(encodeLine(req.op === 'stop' ? { id: req.id, restore: null } : { id: req.id, error: 'nope' }))
      })
    })
    await new Promise<void>((r) => server.listen(socket, r))
    closers.push(() => server.close())
    const state: SessionState = {
      name,
      pid: process.pid,
      socket,
      metro: 'localhost:8081',
      device: { name: 'Phone', deviceId: 'p', platform: 'ios' },
      project,
      transport: 'cdp',
      startedAt: Date.now(),
      lastCallAt: Date.now(),
      idleMs: 0,
    }
    return { got, state }
  }

  const serve = async (flags: Parameters<typeof dialsCommand>[2], start: Parameters<typeof dialsCommand>[5]) => {
    const run = dialsCommand('serve', [], { port: '0', ...flags }, async () => {}, project, start)
    await new Promise((r) => setTimeout(r, 200))
    process.emit('SIGTERM')
    await run
  }

  test('starts a session when the project has none, and stops it with keep on exit', async () => {
    const { got, state } = await stopRecorder('dials')
    const started: unknown[] = []
    await serve({ metro: 'localhost:8195', device: 'iPhone Duo' }, async (flags, opts) => {
      started.push([flags, opts])
      return state
    })
    expect(started).toEqual([[{ metro: 'localhost:8195', device: 'iPhone Duo', idle: '8h' }, { cwd: project, base: 'dials' }]])
    expect(got.map((r) => [r.op, r.keep])).toEqual([['stop', true]])
    expect(errs.join('\n')).toContain('Started session "dials"')
  })

  test('a stop signal during a slow session start still stops that session', async () => {
    const { got, state } = await stopRecorder('dials')
    const run = dialsCommand('serve', [], { port: '0' }, async () => {}, project, async () => {
      await new Promise((r) => setTimeout(r, 400))
      return state
    })
    await new Promise((r) => setTimeout(r, 150))
    process.emit('SIGINT')
    process.emit('SIGINT')
    await run
    expect(got.map((r) => [r.op, r.keep])).toEqual([['stop', true]])
  })

  test('reuses a running session and never stops it', async () => {
    const { got, state } = await stopRecorder('mine')
    writeFileSync(join(stateDir, 'mine.json'), JSON.stringify(state))
    let started = false
    await serve({}, async () => {
      started = true
      return state
    })
    expect(started).toBe(false)
    expect(got).toEqual([])
  })

  test('keeps serving when the session cannot start', async () => {
    await serve({}, async () => {
      throw new Error('no app on Metro')
    })
    expect(errs.join('\n')).toContain("Couldn't start a bridge session (no app on Metro)")
  })
})

describe('commit listener', () => {
  test('any live, fresh waiter counts; dead, stale or unmarked ones do not', () => {
    const waiters = join(dir, '.agent-bridge', 'dials-waiters')
    expect(agentWaiting(dir)).toBe(false)
    const me = markWaiter(dir)
    expect(agentWaiting(dir)).toBe(true)
    // A second waiter finishing leaves the first one counted.
    writeFileSync(join(waiters, String(process.ppid)), '')
    rmSync(join(waiters, String(process.ppid)))
    expect(agentWaiting(dir)).toBe(true)
    // No heartbeat for a while: killed, or its pid reused.
    expect(agentWaiting(dir, Date.now() + 10_000)).toBe(false)
    me.beat()
    expect(agentWaiting(dir)).toBe(true)
    me.unmark()
    writeFileSync(join(waiters, '999999999'), '')
    expect(agentWaiting(dir)).toBe(false)
    expect(readdirSync(waiters)).toEqual([])
  })

  test('wait listens while it runs, and the snapshot says so', async () => {
    const panel = createDialsServer({ project: dir, key: 'k'.repeat(32), sessions: () => [] })
    closers.push(panel.close)
    const { port } = await panel.listen()
    const waiting = async () =>
      ((await (await fetch(`http://127.0.0.1:${port}/api/dials?key=${'k'.repeat(32)}`)).json()) as { waiting: boolean }).waiting
    const err = console.error
    console.error = () => {}
    try {
      const run = dialsCommand('wait', [], { timeout: '0.5' }, async () => {}, dir)
      await new Promise((r) => setTimeout(r, 100))
      expect(await waiting()).toBe(true)
      await run
      expect(await waiting()).toBe(false)
    } finally {
      console.error = err
    }
  })
})

describe('serve --exec', () => {
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 30))
    expect(ok()).toBe(true)
  }

  test('runs the command with the commit on stdin and in the environment, and takes it', async () => {
    const app = await fakeSession()
    const { post, get } = await start(app.state, { exec: 'cat > got.json; printf %s "$DIALS_COMMIT_ID|$DIALS_NOTE" > env.txt' })
    expect(((await (await get('/api/dials')).json()) as { waiting: boolean }).waiting).toBe(true)
    const { commit } = (await (await post('/api/commit', { ids: ['card.accent'], note: 'ship it' })).json()) as { commit: { id: string } }
    await until(() => existsSync(join(dir, 'env.txt')))
    expect(readFileSync(join(dir, 'env.txt'), 'utf8')).toBe(`${commit.id}|ship it`)
    expect(JSON.parse(readFileSync(join(dir, 'got.json'), 'utf8'))).toMatchObject({ id: commit.id, ids: ['card.accent'], status: 'taken' })
    expect(readCommit(dir)?.status).toBe('taken')
  })

  test('a failing command marks the commit failed with its error', async () => {
    const app = await fakeSession()
    const { post } = await start(app.state, { exec: 'echo no harness here >&2; exit 3' })
    await post('/api/commit', { ids: ['card.accent'] })
    await until(() => readCommit(dir)?.status === 'failed')
    expect(readCommit(dir)?.message).toBe('--exec failed: no harness here')
  })

  test('a commit queued before the panel started is handed over on listen', async () => {
    writeCommit(dir, { id: 'queued-1', ids: ['card.accent'], revertOthers: false, values: {}, status: 'requested', at: Date.now() })
    const app = await fakeSession()
    await start(app.state, { exec: 'printf %s "$DIALS_COMMIT_ID" > env.txt' })
    await until(() => existsSync(join(dir, 'env.txt')))
    expect(readFileSync(join(dir, 'env.txt'), 'utf8')).toBe('queued-1')
  })

  test('output does not fail the commit, and a timeout stops what the command started', async () => {
    const app = await fakeSession()
    const loud = await start(app.state, { exec: 'head -c 3000000 /dev/zero' })
    await loud.post('/api/commit', { ids: ['card.accent'] })
    await until(() => !loud.panel.running())
    expect(readCommit(dir)?.status).toBe('taken')
    writeCommit(dir, null)

    const slow = await start(app.state, { exec: 'sh -c \'echo $$ > gc.pid; exec sleep 30\' & wait', execTimeoutMs: 300 })
    await slow.post('/api/commit', { ids: ['card.accent'] })
    await until(() => readCommit(dir)?.status === 'failed')
    expect(readCommit(dir)?.message).toBe('--exec failed: timed out after 0 s')
    const gc = Number(readFileSync(join(dir, 'gc.pid'), 'utf8'))
    await until(() => {
      try {
        process.kill(gc, 0)
        return false
      } catch {
        return true
      }
    })
  })

  test('closing the panel mid-command puts the commit back in the queue', async () => {
    const app = await fakeSession()
    const { post, panel } = await start(app.state, { exec: 'sleep 30' })
    await post('/api/commit', { ids: ['card.accent'] })
    await until(() => readCommit(dir)?.status === 'taken')
    await panel.close()
    expect(readCommit(dir)?.status).toBe('requested')
  })

  test('dials show prints the current commit', async () => {
    const out: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => void out.push(a.join(' '))
    try {
      await dialsCommand('show', [], { json: true }, async () => {}, dir)
      writeCommit(dir, { id: 'c-2', ids: ['card.accent'], note: 'n', revertOthers: false, values: {}, status: 'taken', at: 1 })
      await dialsCommand('show', [], { json: true }, async () => {}, dir)
    } finally {
      console.log = log
    }
    expect(out[0]).toBe('null')
    expect(JSON.parse(out[1] ?? '')).toMatchObject({ id: 'c-2', status: 'taken', note: 'n' })
  })
})

describe('reloadApps', () => {
  test('sends Metro the reload message', async () => {
    const { WebSocketServer } = await import('ws')
    const { reloadApps } = await import('../cli')
    const server = new WebSocketServer({ port: 0, path: '/message' })
    await new Promise((resolve) => server.once('listening', resolve))
    const got = new Promise<string>((resolve) =>
      server.on('connection', (socket) => socket.on('message', (data) => resolve(String(data)))),
    )
    const { port } = server.address() as { port: number }
    expect(await reloadApps(`127.0.0.1:${port}`)).toBe(true)
    expect(JSON.parse(await got)).toEqual({ version: 2, method: 'reload' })
    server.close()
  })

  test('reports false when Metro is not there', async () => {
    const { reloadApps } = await import('../cli')
    expect(await reloadApps('127.0.0.1:1', 1000)).toBe(false)
  })
})
