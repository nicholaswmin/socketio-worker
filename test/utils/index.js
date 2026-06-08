import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import vm from 'node:vm'
import { WorkerHost } from './worker.js'

export class Fixture {
  constructor() {
    this.host = new WorkerHost()
    this.script = this.host.script
    this.library = this.host.library
    this.context = this.host.mainContext()
  }

  load() {
    vm.runInContext(readFileSync(this.script, 'utf8'), this.context, {
      filename: this.script
    })

    return this.context.SocketIOWorker
  }

  close() {
    this.host.close()
  }
}

export const server = async (options = {}) => {
  const http = createServer()
  // aggressive ping speeds up disconnect detection in tests
  const io = new Server(http, {
    cors: { origin: '*' },
    pingInterval: 2000,
    pingTimeout: 2000,
    ...options
  })

  await new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })

  return {
    io,
    url: `http://127.0.0.1:${http.address().port}`,
    close: async () => {
      await new Promise(resolve => io.close(resolve))

      if (http.listening)
        await new Promise((resolve, reject) => {
          http.close(error => error ? reject(error) : resolve())
        })
    }
  }
}

export const once = (target, event) =>
  new Promise(resolve => {
    target.once(event, (...args) => resolve(args))
  })

export const plain = value =>
  JSON.parse(JSON.stringify(value))
