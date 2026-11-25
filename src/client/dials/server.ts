// The local web panel's server: one key, every route, fans out to the project's live sessions.
import { execFileSync, execFile } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from 'node:http'
import type { AddressInfo } from 'node:net'

import { sessionRequest } from '../session/client'
import { agentWaiting, cancelCommit, inFlight, readCommit, readDials, updateCommit } from '../session/dials-store'
import type { CommitRequest, DialInfo } from '../session/dials-store'
import {
  type SessionState,
  inProject,
  listSessions,
  projectRoot,
} from '../session/state'
import { scanDialCalls } from './cli'
import { PANEL_HTML } from './panel-page'

export type PanelDevice = { name: string; platform: string; session: string }
export type DialSource = { file: string; line: number }
export type PanelDial = DialInfo & { saved: boolean; source?: DialSource }
export type PanelSnapshot = {
  /** Live bridge sessions in the project; 0 means the panel can't reach any app. */
  sessions: number
  devices: PanelDevice[]
  dials: PanelDial[]
  tokens: unknown
  labels: Record<string, string>
  commit: CommitRequest | null
  /** Whether a `dials wait` is listening, so a commit gets picked up. */
  waiting: boolean
  capture: boolean
}
export type Rect = { x: number; y: number; width: number; height: number }
export type Capture =
  | { device: string; png: string; rect: Rect | null; rects: Rect[]; scale: number; window?: { width: number; height: number } }
  | { device: string; error: string }

export type DialsServerOptions = {
  /** Default: the project at the current directory. */
  project?: string
  /** Default 127.0.0.1. */
  host?: string
  /** Default 0 (any free port). */
  port?: number
  /** Default: 128 random bits as hex. */
  key?: string
  /** How often the event stream looks for changes. Default 500 ms. */
  pollMs?: number
  /** Sessions to fan out to. Default: live sessions in the project. */
  sessions?: () => SessionState[]
  /** Shell command that writes a PNG to `{out}`, for apps without screen.capture. Default: env AGENT_BRIDGE_DIALS_SCREENSHOT. */
  screenshotCmd?: string
  /** Colour sent with every `dial.highlight`; a dial's own `outline` still wins on the device. */
  outline?: string
  /** Pause after setting a variant, before its screenshot. Default 100 ms. */
  renderWaitMs?: number
}

type ToolResult = { ok: true; value: unknown } | { ok: false; error: string }

async function callTool(
  session: SessionState,
  tool: string,
  args: unknown[],
  save?: false,
): Promise<ToolResult> {
  try {
    const res = await sessionRequest(session, { op: 'call', tool, args, ...(save === false && { save }) })
    if (res.error || !res.result) return { ok: false, error: res.error ?? 'No result' }
    return res.result.ok
      ? { ok: true, value: res.result.value }
      : { ok: false, error: res.result.error }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

class CommitBusyError extends Error {
  constructor() {
    super('A commit is already in flight; wait for it or cancel it')
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Runs the user's screenshot command with a temp file for {out}; the file is gone before this returns. */
function runScreenshotCmd(cmd: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dials-shot-'))
  const out = join(dir, 'shot.png')
  return new Promise<string>((resolve, reject) => {
    execFile(
      '/bin/sh',
      ['-c', cmd.replaceAll('{out}', '"$1"'), 'sh', out],
      { timeout: 30_000 },
      (error, _stdout, stderr) => {
        try {
          if (error) throw new Error(`screenshot command failed: ${stderr.trim() || error.message}`)
          resolve(readFileSync(out).toString('base64'))
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      },
    )
  })
}

const isTokens = (v: unknown): v is { tokens: unknown; labels?: Record<string, string> } =>
  !!v && typeof v === 'object' && 'tokens' in v

const ROUTES = new Set(['/api/highlight', '/api/capture', '/api/capture-variants', '/api/commit', '/api/commit-cancel'])

export function createDialsServer(options: DialsServerOptions = {}) {
  const project = options.project ?? projectRoot()
  const host = options.host ?? '127.0.0.1'
  const key = options.key ?? randomBytes(16).toString('hex')
  const pollMs = options.pollMs ?? 500
  const sessions =
    options.sessions ?? (() => listSessions().filter((s) => inProject(s.project, project)))

  const screenshotCmd = options.screenshotCmd ?? process.env.AGENT_BRIDGE_DIALS_SCREENSHOT
  const renderWaitMs = options.renderWaitMs ?? 100
  const outline = options.outline
  const highlightArgs = (id: string | null) => (id !== null && outline ? [id, { color: outline }] : [id])

  let scanned: { at: number; calls: ReturnType<typeof scanDialCalls> } | undefined
  const sourceOf = (id: string): DialSource | undefined => {
    if (!scanned || Date.now() - scanned.at > 5000) {
      try {
        scanned = { at: Date.now(), calls: scanDialCalls(project) }
      } catch {
        scanned = { at: Date.now(), calls: [] }
      }
    }
    const call = scanned.calls.find((c) => c.id === id)
    return call && { file: call.file, line: call.line }
  }

  const authorized = (req: IncomingMessage, url: URL) => {
    const given = url.searchParams.get('key') ?? req.headers['x-dials-key']
    if (typeof given !== 'string') return false
    const a = Buffer.from(given)
    const b = Buffer.from(key)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  async function snapshot(): Promise<PanelSnapshot> {
    const live = sessions()
    const lists = await Promise.all(
      live.map(async (session) => ({
        session,
        list: await callTool(session, 'dial.list', []),
        tokens: await callTool(session, 'dial.tokens', []),
      })),
    )
    const devices: PanelDevice[] = []
    const byId = new Map<string, DialInfo>()
    let tokens: unknown = null
    let labels: Record<string, string> = {}
    for (const { session, list, tokens: t } of lists) {
      // An app with no dials answers "Unknown tool": not a device for the panel.
      if (!list.ok || !Array.isArray(list.value)) continue
      devices.push({
        name: session.device.name,
        platform: session.device.platform,
        session: session.name,
      })
      for (const dial of list.value as DialInfo[]) if (!byId.has(dial.id)) byId.set(dial.id, dial)
      if (tokens === null && t.ok && t.value) {
        // Older apps return the bare tree.
        tokens = isTokens(t.value) ? t.value.tokens : t.value
        if (isTokens(t.value) && t.value.labels) labels = t.value.labels
      }
    }
    const saved = readDials(project)
    const dials = [...byId.values()].map((dial) => ({
      ...dial,
      saved: JSON.stringify(saved[dial.id]?.value) === JSON.stringify(dial.value),
      source: sourceOf(dial.id),
    }))
    return {
      sessions: live.length,
      devices,
      dials,
      tokens,
      labels,
      commit: readCommit(project),
      waiting: agentWaiting(project),
      capture: devices.length > 0 && (!!screenshotCmd || (await anyCanCapture(lists.filter((l) => l.list.ok).map((l) => l.session)))),
    }
  }

  const pick = (only?: string[]) =>
    sessions().filter((s) => !only?.length || only.includes(s.device.name) || only.includes(s.name))

  const highlighted = new Map<string, string | null>()
  const queues = new Map<string, Promise<unknown>>()
  // One capture at a time per device: each one clears and restores the outline.
  const serial = <T>(session: SessionState, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(session.name) ?? Promise.resolve()).then(run, run)
    queues.set(session.name, next.catch(() => {}))
    return next
  }

  async function highlight(id: string | null, only?: string[]) {
    return Promise.all(
      pick(only).map(async (session) => {
        const res = await callTool(session, 'dial.highlight', highlightArgs(id))
        if (res.ok) highlighted.set(session.name, id)
        return { device: session.device.name, session: session.name, ...res }
      }),
    )
  }

  const probes = new Map<string, Promise<boolean>>()
  const canCapture = (session: SessionState) => {
    const k = `${session.name}:${session.startedAt}`
    let probe = probes.get(k)
    if (!probe) {
      probe = serial(session, () => callTool(session, 'screen.capture', [{ base64: true, format: 'jpg', quality: 0.1, maxBase64: 1 }])).then((r) => r.ok)
      probes.set(k, probe)
    }
    return probe
  }
  const anyCanCapture = async (sessions: SessionState[]) => (await Promise.all(sessions.map(canCapture))).some(Boolean)

  async function screenshot(session: SessionState): Promise<string> {
    // The panel is not an agent's context, so it can take a full-size JPEG.
    const opts = { base64: true, format: 'jpg', quality: 0.8, maxBase64: 3_000_000 }
    const shot = await callTool(session, 'screen.capture', [opts])
    const base64 = shot.ok ? (shot.value as { base64?: unknown } | null)?.base64 : undefined
    if (typeof base64 === 'string' && base64) return `data:image/jpeg;base64,${base64}`
    if (screenshotCmd) return runScreenshotCmd(screenshotCmd)
    if (shot.ok && typeof (shot.value as { path?: unknown } | null)?.path === 'string')
      throw new Error('screenshot too large to send (over 3 MB); set --screenshot-cmd to capture it another way')
    throw new Error('no screenshot source')
  }

  const captureOne = (session: SessionState, id: string): Promise<Capture> =>
    serial(session, async () => {
      const device = session.device.name
      try {
        await callTool(session, 'dial.highlight', [null])
        const rects = await callTool(session, 'dial.rects', [id])
        if (!rects.ok) throw new Error(rects.error)
        const value = rects.value as { rects?: Rect[]; scale?: number; window?: { width: number; height: number } }
        const png = await screenshot(session)
        const list = Array.isArray(value.rects) ? value.rects : []
        return { device, png, rect: list[0] ?? null, rects: list, scale: value.scale ?? 1, ...(value.window && { window: value.window }) }
      } catch (error) {
        return { device, error: error instanceof Error ? error.message : String(error) }
      } finally {
        // Re-read: a highlight sent while this ran must win over the one from before.
        const on = highlighted.get(session.name)
        if (on) await callTool(session, 'dial.highlight', highlightArgs(on))
      }
    })

  const capture = (id: string, only?: string[]) =>
    Promise.all(pick(only).map((session) => captureOne(session, id)))

  async function captureVariants(id: string, only?: string[]) {
    const session = pick(only)[0]
    if (!session) throw new Error('no device connected')
    const list = await callTool(session, 'dial.list', [])
    const dial = list.ok && Array.isArray(list.value) ? (list.value as DialInfo[]).find((d) => d.id === id) : undefined
    if (!dial?.options) throw new Error(`${id} is not a variant dial`)
    const out: Record<string, Capture> = {}
    try {
      for (const option of dial.options) {
        const set = await callTool(session, 'dial.set', [id, option], false)
        if (set.ok) await sleep(renderWaitMs)
        out[String(option)] = set.ok
          ? await captureOne(session, id)
          : { device: session.device.name, error: set.error }
      }
    } finally {
      await callTool(session, 'dial.set', [id, dial.value], false)
    }
    return out
  }

  async function requestCommit(body: { ids?: unknown; note?: unknown; revertOthers?: unknown }) {
    if (!Array.isArray(body.ids) || !body.ids.length) throw new Error('ids must be a non-empty list')
    const ids = body.ids.map(String)
    const { dials } = await snapshot()
    const unknown = ids.filter((id) => !dials.some((d) => d.id === id))
    if (unknown.length) throw new Error(`Unknown dials: ${unknown.join(', ')}`)
    const commit: CommitRequest = {
      id: randomUUID(),
      ids,
      ...(typeof body.note === 'string' && body.note ? { note: body.note } : {}),
      revertOthers: body.revertOthers === true,
      values: Object.fromEntries(
        dials
          .filter((d) => ids.includes(d.id))
          .map((d) => [d.id, { value: d.value, original: d.original, type: d.type, source: d.source }]),
      ),
      status: 'requested',
      at: Date.now(),
    }
    updateCommit(project, (current) => {
      if (inFlight(current)) throw new CommitBusyError()
      return commit
    })
    return commit
  }

  async function setDial(id: string, value: unknown, only?: string[], save?: false) {
    const targets = pick(only)
    return Promise.all(
      targets.map(async (session) => ({
        device: session.device.name,
        session: session.name,
        ...(await callTool(session, 'dial.set', [id, value], save)),
      })),
    )
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let text = ''
      req.on('data', (chunk: Buffer) => {
        text += chunk
        if (text.length > 1_000_000) {
          reject(new Error('Body too large'))
          req.destroy()
        }
      })
      req.on('end', () => resolve(text))
      req.on('error', reject)
    })

  const streams = new Set<ServerResponse>()
  let poller: ReturnType<typeof setInterval> | undefined
  let lastSent = ''
  let polling = false
  const poll = async () => {
    if (polling) return
    polling = true
    try {
      const text = JSON.stringify(await snapshot())
      if (text === lastSent) return
      lastSent = text
      for (const res of streams) res.write(`data: ${text}\n\n`)
    } catch {
    } finally {
      polling = false
    }
  }

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!authorized(req, url)) return json(res, 401, { error: 'Missing or wrong key' })
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return void res.end(PANEL_HTML)
      }
      if (req.method === 'GET' && url.pathname === '/api/dials') return json(res, 200, await snapshot())
      if (req.method === 'POST' && url.pathname === '/api/dials/set') {
        let body: { id?: unknown; value?: unknown; devices?: unknown; save?: unknown }
        try {
          body = JSON.parse(await readBody(req)) as typeof body
        } catch {
          return json(res, 400, { error: 'Body must be JSON: {id, value, devices?}' })
        }
        if (typeof body.id !== 'string') return json(res, 400, { error: 'id must be a string' })
        const only = Array.isArray(body.devices) ? body.devices.map(String) : undefined
        const results = await setDial(body.id, body.value, only, body.save === false ? false : undefined)
        void poll()
        return json(res, 200, { results })
      }
      if (req.method === 'POST' && ROUTES.has(url.pathname)) {
        let body: Record<string, unknown>
        try {
          body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        } catch {
          return json(res, 400, { error: 'Body must be JSON' })
        }
        const only = Array.isArray(body.devices) ? body.devices.map(String) : undefined
        const id = typeof body.id === 'string' ? body.id : null
        try {
          switch (url.pathname) {
            case '/api/highlight':
              if (body.id !== null && id === null) return json(res, 400, { error: 'id must be a string or null' })
              return json(res, 200, { results: await highlight(id, only) })
            case '/api/capture':
              if (!id) return json(res, 400, { error: 'id must be a string' })
              return json(res, 200, { results: await capture(id, only) })
            case '/api/capture-variants':
              if (!id) return json(res, 400, { error: 'id must be a string' })
              return json(res, 200, await captureVariants(id, only))
            case '/api/commit-cancel': {
              const commit = cancelCommit(project)
              void poll()
              return json(res, 200, { commit })
            }
            default: {
              const commit = await requestCommit(body)
              void poll()
              return json(res, 200, { commit })
            }
          }
        } catch (error) {
          if (error instanceof CommitBusyError) return json(res, 409, { error: error.message })
          return json(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        res.write(': open\n\n')
        streams.add(res)
        if (lastSent) res.write(`data: ${lastSent}\n\n`)
        poller ??= setInterval(() => void poll(), pollMs)
        void poll()
        req.on('close', () => {
          streams.delete(res)
          if (!streams.size) {
            clearInterval(poller)
            poller = undefined
            lastSent = ''
          }
        })
        return
      }
      json(res, 404, { error: 'Not found' })
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      else res.end()
    }
  })

  return {
    key,
    host,
    server,
    snapshot,
    async listen(): Promise<{ host: string; port: number }> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port ?? 0, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      return { host, port: (server.address() as AddressInfo).port }
    },
    async close() {
      clearInterval(poller)
      for (const res of streams) res.end()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** The tailnet IPv4 and the short MagicDNS name (iOS ATS rejects full .ts.net names over http). */
export function tailscaleAddress(run = (args: string[]) => execFileSync('tailscale', args, { encoding: 'utf8' })) {
  let ip: string
  try {
    ip = run(['ip', '-4']).trim().split('\n')[0] ?? ''
  } catch {
    throw new Error('tailscale is not available or not running; start it, or drop --tailscale')
  }
  if (!ip) throw new Error('tailscale gave no IPv4 address; is it logged in?')
  let name = ip
  try {
    const dns = (JSON.parse(run(['status', '--json'])) as { Self?: { DNSName?: string } }).Self?.DNSName
    if (dns) name = dns.replace(/\.$/, '').split('.')[0] ?? ip
  } catch {}
  return { ip, name }
}
