// Sprout's live inbox for development: a socket.io server that pushes a new
// inbox message whenever you ask it to.
//
//   node realtime-server.mjs                      # PORT=8138 by default
//   curl 'localhost:8138/push?title=Monstera%20has%20a%20new%20leaf'
import { createServer } from 'node:http'
import { Server } from 'socket.io'

const port = Number(process.env.PORT ?? 8138)
let count = 0

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== '/push') {
    res.writeHead(404).end()
    return
  }
  count += 1
  const message = {
    id: `live-${count}`,
    icon: 'sparkles',
    tint: 'accent',
    title: url.searchParams.get('title') ?? `Live update ${count}`,
    body: url.searchParams.get('body') ?? 'Sent by the realtime server.',
    time: 'Now',
    unread: true,
  }
  io.emit('inbox:new', message)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ sent: message, clients: io.engine.clientsCount }))
})

const io = new Server(http, { cors: { origin: '*' } })
io.on('connection', (socket) => console.log(`connected ${socket.id}`))

http.listen(port, () => console.log(`realtime server on :${port}`))
