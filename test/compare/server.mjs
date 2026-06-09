// Generic socket.io echo/sink server + static serving for the comparison page.
// Serves the REAL package source (../../socketio-worker.js) and the vendored
// browser client (../utils/socket.io.js) so both `io` and the facade run the
// exact code under test. Nothing app-specific here.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'

const DIR = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const MIME = { '.html': 'text/html', '.js': 'application/javascript' }
const FILES = {
  '/page.html': join(DIR, 'page.html'),
  '/socketio-worker.js': join(ROOT, 'socketio-worker.js'),
  '/socket.io.js': join(ROOT, 'test', 'utils', 'socket.io.js')
}

const attach = httpServer => {
  const io = new Server(httpServer, {
    transports: ['websocket'],
    pingInterval: 2000,
    pingTimeout: 2000
  })

  io.on('connection', socket => {
    socket.on('bench:event', () => {})
    socket.on('bench:ack', (data, cb) => { if (cb) cb({ ok: true }) })
  })

  return io
}

export const start = async () => {
  let io
  const httpServer = http.createServer(async (req, res) => {
    const path = req.url.split('?')[0]
    const file = FILES[path] || (path === '/' ? FILES['/page.html'] : null)

    if (!file) { res.statusCode = 404; return res.end('not found') }

    try {
      const body = await readFile(file)
      res.setHeader('content-type', MIME[extname(file)] || 'text/plain')
      res.end(body)
    } catch (error) { res.statusCode = 500; res.end(error.message) }
  })

  io = attach(httpServer)
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))

  return {
    url: `http://127.0.0.1:${httpServer.address().port}`,
    // abrupt transport drop (server stays up) -> client sees 'transport close'
    // and auto-reconnects, unlike a clean server disconnect.
    dropTransport: () => { for (const s of io.sockets.sockets.values()) s.conn.close() },
    stop: async () => {
      await new Promise(resolve => io.close(resolve))
      if (httpServer.listening)
        await new Promise(resolve => httpServer.close(resolve))
    }
  }
}
