import WebSocket from 'ws'

import type { DeviceInfo, ResultMessage } from '../shared/protocol'

export type TransportName = 'expo' | 'cdp'

export type Connection = {
  transport: TransportName
  device: DeviceInfo
  call: (
    tool: string,
    args: unknown[],
    timeoutMs: number,
  ) => Promise<ResultMessage>
  close: () => void
}

/**
 * Opens a socket and resolves once it is open. A persistent error listener
 * keeps later socket errors from surfacing as unhandled; they show up as a
 * close instead.
 */
export function openSocket(
  url: string,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined)
    let opened = false
    ws.on('error', (event: unknown) => {
      if (opened) return
      const message = (event as { message?: string })?.message ?? String(event)
      reject(new Error(`Could not open ${url}: ${message}`))
    })
    ws.once('close', () => {
      if (!opened) reject(new Error(`${url} closed before opening`))
    })
    ws.once('open', () => {
      opened = true
      resolve(ws)
    })
  })
}

export const newCallId = () =>
  `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Waits for a reply keyed by call id, with a timeout that names the tool. */
export function createPending() {
  const waiting = new Map<string, (result: ResultMessage) => void>()
  return {
    wait(id: string, tool: string, timeoutMs: number): Promise<ResultMessage> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(new Error(`No reply to "${tool}" within ${timeoutMs} ms`))
        }, timeoutMs)
        waiting.set(id, (result) => {
          clearTimeout(timer)
          waiting.delete(id)
          resolve(result)
        })
      })
    },
    settle(result: ResultMessage) {
      waiting.get(result.id)?.(result)
    },
    failAll(reason: string) {
      for (const [id, done] of waiting) {
        done({ id, from: '', ok: false, error: reason, ms: 0 })
      }
    },
  }
}
