import { test } from 'node:test'
import { Fixture, once, plain, server } from '#test/utils'

class Auth {
  constructor(token) {
    this.token = token
  }
}

class Query {
  constructor(room) {
    this.room = room
  }
}

test('io()', async t => {
  t.beforeEach(t => {
    t.fixture = new Fixture()
    t.fixture.load()
    t.io = t.fixture.context.io
    t.io.config = { src: t.fixture.script, lib: t.fixture.library }
  })

  t.afterEach(async t => {
    await t.socket?.close?.().catch(() => null)
    t.fixture.close()
    await t.server?.close()
  })

  await t.test('#connect', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.socket = t.io(t.server.url, {
        autoConnect: false,
        transports: ['websocket'],
        reconnection: false
      })
    })

    await t.test('with class-instance auth', async t => {
      t.beforeEach(async t => {
        t.server.io.use((socket, next) => {
          t.handshakeAuth = socket.handshake.auth
          next()
        })
        t.socket.auth = new Auth('ok')
        t.socket.connect()
        await once(t.socket, 'connect')
      })

      await t.test('normalizes the instance into the handshake auth', t => {
        t.assert.deepStrictEqual(t.handshakeAuth, { token: 'ok' })
      })
    })

    await t.test('when the server rejects the handshake', async t => {
      t.beforeEach(async t => {
        t.server.io.use((socket, next) => next(new Error('forbidden')))
        t.socket.connect()
        ;[t.failure] = await once(t.socket, 'connect_error')
      })

      await t.test('emits connect_error carrying the Error message', t => {
        t.assert.match(t.failure.message, /forbidden/i)
      })
    })

    await t.test('with a class-instance query', async t => {
      t.beforeEach(async t => {
        t.received = []
        t.server.io.use((socket, next) => {
          t.received.push(socket.handshake.query.room)
          next()
        })
        t.socket.io.opts.query = new Query('blue')
        t.socket.connect()
        await once(t.socket, 'connect')
      })

      await t.test('normalizes and forwards query to the handshake', t => {
        t.assert.deepStrictEqual(t.received, ['blue'])
      })
    })

    await t.test('with autoConnect disabled', async t => {
      t.beforeEach(async t => {
        await new Promise(resolve => setTimeout(resolve, 50))
        t.before = t.socket.connected
        t.socket.connect()
        await once(t.socket, 'connect')
      })

      await t.test('connects only once connect() is called', t => {
        t.assert.deepStrictEqual(
          { before: t.before, after: t.socket.connected },
          { before: false, after: true }
        )
      })
    })

    await t.test('once connected', async t => {
      t.beforeEach(async t => {
        t.socket.connect()
        await once(t.socket, 'connect')
      })

      await t.test('exposes a non-null socket id', t => {
        t.assert.match(String(t.socket.id), /\w+/)
      })
    })
  })

  await t.test('#emit', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.socket = t.io(t.server.url, {
        autoConnect: false,
        transports: ['websocket'],
        reconnection: false
      })
    })

    await t.test('with a plain payload', async t => {
      t.beforeEach(async t => {
        const arrived = new Promise(resolve =>
          t.server.io.on('connection', s => s.on('news', resolve))
        )
        t.socket.connect()
        await once(t.socket, 'connect')
        t.socket.emit('news', { headline: 'hello' })
        t.payload = await arrived
      })

      await t.test('forwards the payload to the server', t => {
        t.assert.partialDeepStrictEqual(t.payload, { headline: 'hello' })
      })
    })

    await t.test('with an acknowledgement callback', async t => {
      t.beforeEach(async t => {
        t.server.io.on('connection', s =>
          s.on('request-users', cb => cb([{ id_socket: 'a' }]))
        )
        t.socket.connect()
        await once(t.socket, 'connect')
        t.reply = await new Promise(resolve =>
          t.socket.emit('request-users', resolve)
        )
      })

      await t.test('invokes the callback with the server reply', t => {
        t.assert.partialDeepStrictEqual(t.reply, [{ id_socket: 'a' }])
      })
    })

    await t.test('with a nested function in the payload', async t => {
      t.beforeEach(async t => {
        const arrived = new Promise(resolve =>
          t.server.io.on('connection', s => s.on('attr', resolve))
        )
        t.socket.connect()
        await once(t.socket, 'connect')
        t.socket.emit('attr', {
          items: [{ id: 1 }],
          changedItems: [{ undo: () => {}, redo: () => {} }]
        })
        t.payload = await arrived
      })

      await t.test('strips functions like Socket.IO does', t => {
        t.assert.deepStrictEqual(t.payload, {
          items: [{ id: 1 }],
          changedItems: [{}]
        })
      })
    })

    await t.test('with mixed JSON values', async t => {
      t.beforeEach(async t => {
        const arrived = new Promise(resolve =>
          t.server.io.on('connection', s => s.on('mixed', resolve))
        )
        t.socket.connect()
        await once(t.socket, 'connect')
        t.original = {
          a: 1,
          b: undefined,
          c: [1, undefined, 3],
          d: { toJSON: () => 'X' }
        }
        t.socket.emit('mixed', t.original)
        t.payload = await arrived
      })

      await t.test('matches Socket.IO JSON serialization', t => {
        t.assert.deepStrictEqual(t.payload, plain(t.original))
      })
    })

    await t.test('before connecting', async t => {
      t.beforeEach(async t => {
        const arrived = new Promise(resolve =>
          t.server.io.on('connection', s => s.on('buffered', resolve))
        )
        t.socket.emit('buffered', { early: true })
        t.socket.connect()
        t.payload = await arrived
      })

      await t.test('buffers then flushes on connect', t => {
        t.assert.partialDeepStrictEqual(t.payload, { early: true })
      })
    })

    await t.test('with a circular payload', async t => {
      t.beforeEach(async t => {
        t.socket.connect()
        await once(t.socket, 'connect')
      })

      await t.test('throws a TypeError', t => {
        const cyclic = {}
        cyclic.self = cyclic
        t.assert.throws(() => t.socket.emit('evt', cyclic), {
          name: 'TypeError'
        })
      })
    })

    await t.test('with binary data', async t => {
      t.beforeEach(async t => {
        t.socket.connect()
        await once(t.socket, 'connect')
      })

      await t.test('throws an unsupported error', t => {
        t.assert.throws(
          () => t.socket.emit('evt', new Uint8Array([1, 2, 3])),
          /binary/i
        )
      })
    })
  })

  await t.test('#on', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.socket = t.io(t.server.url, {
        autoConnect: false,
        transports: ['websocket'],
        reconnection: false
      })
      const [[socket]] = await Promise.all([
        once(t.server.io, 'connection'),
        (t.socket.connect(), once(t.socket, 'connect'))
      ])
      t.serverSocket = socket
    })

    await t.test('when the server emits an event', async t => {
      t.beforeEach(async t => {
        const arrived = once(t.socket, 'news')
        t.serverSocket.emit('news', { headline: 'hi' })
        ;[t.payload] = await arrived
      })

      await t.test('forwards the payload', t => {
        t.assert.partialDeepStrictEqual(t.payload, { headline: 'hi' })
      })
    })

    await t.test('on disconnect', async t => {
      t.beforeEach(async t => {
        const arrived = once(t.socket, 'disconnect')
        t.serverSocket.disconnect()
        ;[t.reason] = await arrived
      })

      await t.test('delivers a reason string', t => {
        t.assert.match(t.reason, /\w+/)
      })
    })

    await t.test('with once', async t => {
      t.beforeEach(async t => {
        t.handler = t.mock.fn()
        t.socket.once('news', t.handler)

        let delivered = 0
        const twice = new Promise(resolve =>
          t.socket.on('news', () => { if (++delivered === 2) resolve() })
        )
        t.serverSocket.emit('news', { n: 1 })
        t.serverSocket.emit('news', { n: 2 })
        await twice
      })

      await t.test('fires only on the first event', t => {
        t.assert.strictEqual(t.handler.mock.callCount(), 1)
      })
    })

    await t.test('with off', async t => {
      t.beforeEach(async t => {
        t.handler = t.mock.fn()
        t.socket.on('news', t.handler)
        t.socket.off('news', t.handler)

        const witnessed = once(t.socket, 'tick')
        t.serverSocket.emit('news', { n: 1 })
        t.serverSocket.emit('tick', {})
        await witnessed
      })

      await t.test('stops further delivery', t => {
        t.assert.strictEqual(t.handler.mock.callCount(), 0)
      })
    })
  })

  await t.test('socket.io', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.socket = t.io(t.server.url, {
        autoConnect: false,
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 50,
        reconnectionDelayMax: 50,
        randomizationFactor: 0,
        reconnectionAttempts: 3,
        timeout: 200
      })
    })

    await t.test('on a reconnect cycle', async t => {
      t.beforeEach(async t => {
        t.attempts = []
        t.socket.io.on('reconnect_attempt', attempt => t.attempts.push(attempt))

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          (t.socket.connect(), once(t.socket, 'connect'))
        ])

        const reconnected = new Promise(resolve => {
          let connects = 0
          t.socket.on('connect', () => { if (++connects === 1) resolve() })
        })
        socket.conn.close()
        await reconnected
      })

      await t.test('emits reconnect_attempt with the attempt number', t => {
        t.assert.ok(Number.isInteger(t.attempts[0]))
      })
    })
  })
})
