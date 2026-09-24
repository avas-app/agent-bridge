// A stand-in for Metro with just the two sockets the client uses:
// - /json/list + /inspector/debug, answering CDP by evaluating in this process
//   (where the test starts the app-side cdpTransport),
// - /expo-dev-plugins/broadcast, relaying every frame to every other client.
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { type WebSocket, WebSocketServer } from 'ws'

type Options = {
  /** hostUri in the Expo manifest; omit to behave like bare React Native. */
  hostUri?: (port: number) => string
  /** Origin the inspector accepts; others are dropped right after opening. */
  acceptOrigin?: (port: number) => string
  /** Serve Expo's broadcast socket. */
  expo?: boolean
  /** Answer Runtime.evaluate with "method not found", like Expo Go on Android. */
  noEvaluate?: boolean
}

export async function startFakeMetro(options: Options = {}) {
  const inspector = new WebSocketServer({ noServer: true })
  const broadcast = new WebSocketServer({ noServer: true })
  let port = 0

  const server: Server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify([
          {
            id: 'dev-1',
            title: 'app.test (Fake Phone)',
            appId: 'app.test',
            deviceName: 'Fake Phone',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?device=dev&page=1`,
          },
        ]),
      )
    } else if (
      req.url === '/' &&
      req.headers['expo-platform'] &&
      options.hostUri
    ) {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          extra: { expoClient: { hostUri: options.hostUri(port) } },
        }),
      )
    } else {
      res.statusCode = 404
      res.end()
    }
  })

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0]
    if (path === '/inspector/debug') {
      inspector.handleUpgrade(req, socket, head, (ws) => {
        const expected = options.acceptOrigin?.(port)
        if (expected && req.headers.origin !== expected) ws.terminate()
        else serveCdp(ws, options)
      })
    } else if (path === '/expo-dev-plugins/broadcast' && options.expo) {
      broadcast.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data, isBinary) => {
          for (const client of broadcast.clients) {
            if (client !== ws && client.readyState === 1)
              client.send(data, { binary: isBinary })
          }
        })
      })
    } else {
      socket.destroy()
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port

  return {
    metro: `127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of [...inspector.clients, ...broadcast.clients])
          c.terminate()
        server.close(() => resolve())
      }),
  }
}

function serveCdp(ws: WebSocket, options: Options) {
  const g = globalThis as Record<string, unknown>
  ws.on('message', (data) => {
    const { id, method, params } = JSON.parse(String(data))
    if (method === 'Runtime.evaluate' && options.noEvaluate) {
      ws.send(JSON.stringify({ id, error: { code: -32601, message: method } }))
    } else if (method === 'Runtime.addBinding') {
      g[params.name] = (payload: string) =>
        ws.send(
          JSON.stringify({
            method: 'Runtime.bindingCalled',
            params: { name: params.name, payload },
          }),
        )
      ws.send(JSON.stringify({ id, result: {} }))
    } else if (method === 'Runtime.evaluate') {
      try {
        const value = (0, eval)(params.expression)
        ws.send(
          JSON.stringify({
            id,
            result: { result: { type: typeof value, value } },
          }),
        )
      } catch (error) {
        const description =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
        ws.send(
          JSON.stringify({
            id,
            result: {
              exceptionDetails: {
                text: 'Uncaught',
                exception: { description },
              },
            },
          }),
        )
      }
    } else {
      ws.send(JSON.stringify({ id, result: {} }))
    }
  })
}
