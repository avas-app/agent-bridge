// The local web panel's server: one key, every route, fans out to the project's live sessions.
import { execFileSync } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from 'node:http'
import type { AddressInfo } from 'node:net'

import { sessionRequest } from '../session/client'
import { readDials } from '../session/dials-store'
import type { DialInfo } from '../session/dials-store'
import {
  type SessionState,
  inProject,
  listSessions,
  projectRoot,
} from '../session/state'
import { PANEL_HTML } from './panel-page'

export type PanelDevice = { name: string; platform: string; session: string }
export type PanelDial = DialInfo & { saved: boolean }
export type PanelSnapshot = {
  devices: PanelDevice[]
  dials: PanelDial[]
  tokens: unknown
}

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
}

type ToolResult = { ok: true; value: unknown } | { ok: false; error: string }

async function callTool(
  session: SessionState,
  tool: string,
  args: unknown[],
): Promise<ToolResult> {
  try {
    const res = await sessionRequest(session, { op: 'call', tool, args })
    if (res.error || !res.result) return { ok: false, error: res.error ?? 'No result' }
    return res.result.ok
      ? { ok: true, value: res.result.value }
      : { ok: false, error: res.result.error }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function createDialsServer(options: DialsServerOptions = {}) {
  const project = options.project ?? projectRoot()
  const host = options.host ?? '127.0.0.1'
  const key = options.key ?? randomBytes(16).toString('hex')
  const pollMs = options.pollMs ?? 500
  const sessions =
    options.sessions ?? (() => listSessions().filter((s) => inProject(s.project, project)))

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
    for (const { session, list, tokens: t } of lists) {
      // An app with no dials answers "Unknown tool": not a device for the panel.
      if (!list.ok || !Array.isArray(list.value)) continue
      devices.push({
        name: session.device.name,
        platform: session.device.platform,
        session: session.name,
      })
      for (const dial of list.value as DialInfo[]) if (!byId.has(dial.id)) byId.set(dial.id, dial)
      if (tokens === null && t.ok && t.value) tokens = t.value
    }
    const saved = readDials(project)
    const dials = [...byId.values()].map((dial) => ({
      ...dial,
      saved: JSON.stringify(saved[dial.id]?.value) === JSON.stringify(dial.value),
    }))
    return { devices, dials, tokens }
  }

  async function setDial(id: string, value: unknown, only?: string[]) {
    const targets = sessions().filter(
      (s) => !only?.length || only.includes(s.device.name) || only.includes(s.name),
    )
    return Promise.all(
      targets.map(async (session) => ({
        device: session.device.name,
        session: session.name,
        ...(await callTool(session, 'dial.set', [id, value])),
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
        if (text.length > 1_000_000) reject(new Error('Body too large'))
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
        let body: { id?: unknown; value?: unknown; devices?: unknown }
        try {
          body = JSON.parse(await readBody(req)) as typeof body
        } catch {
          return json(res, 400, { error: 'Body must be JSON: {id, value, devices?}' })
        }
        if (typeof body.id !== 'string') return json(res, 400, { error: 'id must be a string' })
        const only = Array.isArray(body.devices) ? body.devices.map(String) : undefined
        const results = await setDial(body.id, body.value, only)
        void poll()
        return json(res, 200, { results })
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
