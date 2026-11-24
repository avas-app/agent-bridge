import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { encodeLine } from '../../session/protocol'
import type { SessionRequest } from '../../session/protocol'
import type { SessionState } from '../../session/state'
import { dialsCommand, scanDialCalls } from '../cli'
import { createDialsServer, tailscaleAddress } from '../server'

let dir = ''
const closers: Array<() => unknown> = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dials-'))
})
afterEach(async () => {
  while (closers.length) await closers.pop()?.()
  rmSync(dir, { recursive: true, force: true })
})

/** A session socket that answers dial tools from a map; `sets` records dial.set calls. */
async function fakeSession(name: string, device: string, value: string) {
  const sets: unknown[][] = []
  const socket = join(dir, `${name}.sock`)
  const server: Server = createServer((conn) => {
    conn.on('error', () => {})
    createInterface({ input: conn }).on('line', (line) => {
      const req = JSON.parse(line) as SessionRequest
      const ok = (v: unknown) => ({ id: req.id, result: { id: '', from: '', ok: true, value: v, ms: 0 } })
      let res: unknown
      if (req.tool === 'dial.list')
        res = ok([{ id: 'card.accent', type: 'color', value, original: '#111111', renders: 1 }])
      else if (req.tool === 'dial.tokens') res = ok({ colors: { brand: '#0af' } })
      else if (req.tool === 'dial.set') {
        sets.push(req.args ?? [])
        value = String(req.args?.[1])
        res = ok({ id: 'card.accent', type: 'color', value, original: '#111111' })
      } else res = { id: req.id, error: 'nope' }
      conn.write(encodeLine(res))
    })
  })
  await new Promise<void>((r) => server.listen(socket, r))
  closers.push(() => server.close())
  const state: SessionState = {
    name,
    pid: process.pid,
    socket,
    metro: 'localhost:8081',
    project: dir,
    device: { name: device, deviceId: name, platform: 'ios' },
    transport: 'expo',
    startedAt: 1,
    lastCallAt: 1,
    idleMs: 0,
  }
  return { state, sets }
}

describe('dials server', () => {
  test('binds 127.0.0.1 by default', async () => {
    const panel = createDialsServer({ project: dir, sessions: () => [] })
    closers.push(panel.close)
    const bound = await panel.listen()
    expect(bound.host).toBe('127.0.0.1')
    expect(panel.server.address()).toMatchObject({ address: '127.0.0.1' })
  })

  test('401 without the key, 200 with it (query or header)', async () => {
    const panel = createDialsServer({ project: dir, key: 'k'.repeat(32), sessions: () => [] })
    closers.push(panel.close)
    const { port } = await panel.listen()
    const base = `http://127.0.0.1:${port}`
    for (const path of ['/', '/api/dials', '/api/events'])
      expect((await fetch(base + path)).status).toBe(401)
    expect((await fetch(`${base}/api/dials?key=wrong`)).status).toBe(401)
    expect((await fetch(`${base}/?key=${'k'.repeat(32)}`)).status).toBe(200)
    const res = await fetch(`${base}/api/dials`, { headers: { 'x-dials-key': 'k'.repeat(32) } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ devices: [], dials: [], tokens: null })
    const post = await fetch(`${base}/api/dials/set`, { method: 'POST', body: '{}' })
    expect(post.status).toBe(401)
  })

  test('the default key is 128 random bits', () => {
    const a = createDialsServer({ project: dir })
    const b = createDialsServer({ project: dir })
    expect(a.key).toMatch(/^[0-9a-f]{32}$/)
    expect(a.key).not.toBe(b.key)
  })

  test('lists dials from, and sets on, two sessions', async () => {
    const one = await fakeSession('one', 'Phone A', '#111111')
    const two = await fakeSession('two', 'Phone B', '#111111')
    const panel = createDialsServer({ project: dir, key: 'k', sessions: () => [one.state, two.state] })
    closers.push(panel.close)
    const { port } = await panel.listen()
    const base = `http://127.0.0.1:${port}`

    const list = (await (await fetch(`${base}/api/dials?key=k`)).json()) as {
      devices: Array<{ name: string }>
      dials: Array<{ id: string; saved: boolean }>
      tokens: unknown
    }
    expect(list.devices.map((d) => d.name)).toEqual(['Phone A', 'Phone B'])
    expect(list.dials).toHaveLength(1)
    expect(list.tokens).toEqual({ colors: { brand: '#0af' } })

    const post = (body: unknown) =>
      fetch(`${base}/api/dials/set?key=k`, { method: 'POST', body: JSON.stringify(body) }).then(
        (r) => r.json() as Promise<{ results: Array<{ device: string; ok: boolean }> }>,
      )
    const all = await post({ id: 'card.accent', value: '#ff0000' })
    expect(all.results.map((r) => [r.device, r.ok])).toEqual([['Phone A', true], ['Phone B', true]])
    expect(one.sets).toEqual([['card.accent', '#ff0000']])
    expect(two.sets).toEqual([['card.accent', '#ff0000']])

    const only = await post({ id: 'card.accent', value: '#00ff00', devices: ['Phone B'] })
    expect(only.results.map((r) => r.device)).toEqual(['Phone B'])
    expect(one.sets).toHaveLength(1)
    expect(two.sets).toHaveLength(2)
  })

  test('the event stream pushes the dials list', async () => {
    const one = await fakeSession('one', 'Phone A', '#111111')
    const panel = createDialsServer({ project: dir, key: 'k', pollMs: 50, sessions: () => [one.state] })
    closers.push(panel.close)
    const { port } = await panel.listen()
    const res = await fetch(`http://127.0.0.1:${port}/api/events?key=k`)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    let text = ''
    while (!text.includes('data: ')) text += new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    expect(JSON.parse(text.split('data: ')[1]!.trim()).dials[0].id).toBe('card.accent')
  })
})

describe('tailscaleAddress', () => {
  test('uses the tailnet IP and the short MagicDNS name', () => {
    const run = (args: string[]) =>
      args[0] === 'ip' ? '100.64.0.7\n' : JSON.stringify({ Self: { DNSName: 'buildbox.tail1234.ts.net.' } })
    expect(tailscaleAddress(run)).toEqual({ ip: '100.64.0.7', name: 'buildbox' })
  })
})

describe('dials check', () => {
  const files: Record<string, string> = {
    'src/Card.tsx': "const c = dial.color('card.accent', '#fff')\nconst n = dial.number(\"card.radius\", 8, { min: 0 })\n",
    'node_modules/x/index.js': "dial.color('ignored', 1)",
    '.agent-bridge/old.ts': "dial.text('ignored', '')",
    'dist/out.js': "dial.text('ignored', '')",
  }
  const write = () => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    writeFileSync(join(dir, 'package.json'), '{}')
  }
  const run = async (flags = {}, bridge?: { tools: () => unknown[]; call: () => Promise<unknown> }) => {
    const before = process.cwd()
    const log = console.log
    const err = console.error
    const out: string[] = []
    console.log = (...a) => void out.push(a.join(' '))
    console.error = () => {}
    process.exitCode = 0
    process.chdir(dir)
    try {
      await dialsCommand('check', [], flags, async (fn) => fn(bridge as never))
      return { code: process.exitCode ?? 0, out }
    } finally {
      process.chdir(before)
      console.log = log
      console.error = err
      process.exitCode = 0
    }
  }

  test('finds the calls with file:line:id and skips ignored folders', () => {
    write()
    expect(scanDialCalls(dir).map((c) => `${c.file}:${c.line}:${c.id}`)).toEqual([
      'src/Card.tsx:1:card.accent',
      'src/Card.tsx:2:card.radius',
    ])
  })

  test('exits 1 while calls remain and 0 once they are gone', async () => {
    write()
    const found = await run()
    expect(found.code).toBe(1)
    expect(found.out).toContain('src/Card.tsx:1:card.accent')
    writeFileSync(join(dir, 'src/Card.tsx'), "const c = '#fff'\n")
    expect((await run()).code).toBe(0)
  })

  test('--live lists app dials with no source call', async () => {
    write()
    const app = (ids: string[]) => ({
      tools: () => [{ name: 'dial.list' }],
      call: async () => ids.map((id) => ({ id })),
    })
    expect((await run({ live: true }, app(['card.accent', 'card.radius']))).code).toBe(0)
    expect((await run({ live: true }, app(['card.accent', 'card.gone']))).code).toBe(1)
  })
})
