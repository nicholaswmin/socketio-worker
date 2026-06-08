(root => {
  'use strict'

  const CALL_TIMEOUT = 20000

  const isWorkerScope = () =>
    typeof importScripts === 'function' &&
    typeof document === 'undefined'

  const isPlainObject = value => {
    if (Object.prototype.toString.call(value) !== '[object Object]')
      return false

    const prototype = Object.getPrototypeOf(value)

    if (prototype === null || prototype === Object.prototype)
      return true

    const ctor = prototype.constructor

    return typeof ctor === 'function' &&
      ctor.name === 'Object'
  }

  const jsonType = value => {
    if (value === undefined)
      return 'undefined'

    if (typeof value === 'function')
      return 'function'

    if (typeof value === 'symbol')
      return 'symbol'

    if (typeof value === 'bigint')
      return 'bigint'

    if (value && !Array.isArray(value) && !isPlainObject(value))
      return Object.prototype.toString.call(value)

    return typeof value
  }

  const jsonSafeMessage = (path, reason) =>
    `Socket.IO worker JSON: ${path} must be JSON-safe; ${reason}`

  const jsonScalar = (value, path) => {
    if (
      value == null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    )
      return true

    if (typeof value !== 'number')
      return false

    if (Number.isFinite(value))
      return true

    throw new RangeError(
      jsonSafeMessage(path, 'non-finite numbers are not supported')
    )
  }

  const assertJsonArray = (value, path, seen) => {
    for (const [i, item] of value.entries()) {
      if (!(i in value))
        throw new TypeError(
          jsonSafeMessage(path, 'sparse arrays are not supported')
        )

      assertJsonSafe(item, `${path}[${i}]`, seen)
    }
  }

  const assertJsonObject = (value, path, seen) => {
    if (!isPlainObject(value))
      throw new TypeError(
        jsonSafeMessage(path, `${jsonType(value)} is not supported`)
      )

    for (const key of Object.keys(value))
      assertJsonSafe(value[key], `${path}.${key}`, seen)
  }

  const assertJsonSafe = (value, path = 'value', seen = []) => {
    if (jsonScalar(value, path))
      return

    if (typeof value !== 'object')
      throw new TypeError(
        jsonSafeMessage(path, `${jsonType(value)} is not supported`)
      )

    if (seen.includes(value))
      throw new TypeError(jsonSafeMessage(path, 'cycles are not supported'))

    seen.push(value)

    try {
      if (Array.isArray(value))
        assertJsonArray(value, path, seen)
      else
        assertJsonObject(value, path, seen)
    } finally {
      seen.pop()
    }
  }

  const jsonCopy = value => {
    assertJsonSafe(value)

    return value == null ? value : JSON.parse(JSON.stringify(value))
  }

  const safeErrorDetail = value => {
    if (value === undefined)
      return undefined

    try {
      return jsonCopy(value)
    } catch {
      return String(value)
    }
  }

  const serializeError = error => {
    if (!error)
      return { name: 'Error', message: 'Unknown error' }

    const serialized = {
      name: error.name || 'Error',
      message: error.message || String(error)
    }

    if (error.stack)
      serialized.stack = String(error.stack)

    if (error.data !== undefined)
      serialized.data = safeErrorDetail(error.data)

    if (error.description !== undefined)
      serialized.description = safeErrorDetail(error.description)

    if (error.context !== undefined)
      serialized.context = safeErrorDetail(error.context)

    return serialized
  }

  const ERROR_CTORS = {
    Error,
    TypeError,
    RangeError,
    ReferenceError,
    SyntaxError
  }

  const errorConstructor = name => ERROR_CTORS[name] || Error

  const makeError = data => {
    const name = data?.name || 'Error'
    const error = new (errorConstructor(name))(
      data?.message || 'Socket.IO worker call: failed'
    )

    error.name = name

    if (data?.stack)
      error.stack = String(data.stack)

    if (data?.data !== undefined)
      error.data = data.data

    if (data?.description !== undefined)
      error.description = data.description

    if (data?.context !== undefined)
      error.context = data.context

    return error
  }

  const synthesizeFailure = (raw, isMessageError) => {
    const cause = raw?.error || raw

    if (cause instanceof Error)
      return serializeError(cause)

    if (cause && typeof cause === 'object' && cause.message)
      return {
        name: cause.name || 'Error',
        message: String(cause.message),
        ...(cause.filename
          ? { stack: `${cause.filename}:${cause.lineno || 0}` }
          : {})
      }

    return {
      name: 'Error',
      message: isMessageError
        ? 'Socket.IO worker: messageerror (deserialization failed)'
        : 'Socket.IO worker: error'
    }
  }

  const validateCallArgs = args => {
    if (args !== undefined && !Array.isArray(args))
      throw new TypeError(
        `Socket.IO call args: expected array, got ${jsonType(args)}`
      )
  }

  class WorkerMessage {
    constructor(channel) {
      this.channel = channel
    }

    toJSON() {
      const message = {}

      for (const key of Object.keys(this))
        message[key] = this[key]

      return jsonCopy(message)
    }
  }

  class MethodInvocation extends WorkerMessage {
    constructor(id, target, method, args) {
      super('call')
      this.id = id
      this.target = target || 'socket'
      this.method = method
      this.args = args || []
    }
  }

  class MethodResult extends WorkerMessage {
    constructor(id, ok, value) {
      super('call')
      this.id = id
      this.ok = ok

      if (ok)
        this.result = value
      else
        this.error = serializeError(value)
    }
  }

  class Cancellation extends WorkerMessage {
    constructor(id, method) {
      super('cancel')
      this.id = id
      this.method = method
    }
  }

  class PropertyUpdate extends WorkerMessage {
    constructor(reason, patch, value) {
      super('update')
      this.reason = reason
      this.patch = patch

      if (value !== undefined)
        this.value = safeErrorDetail(value)
    }
  }

  class SocketEvent extends WorkerMessage {
    constructor(event, args) {
      super('socket')
      this.event = event
      this.args = args
    }
  }

  function installMain() {
    const VANILLA_REASONS = ['connect', 'disconnect', 'connect_error']

    const connectArgs = args =>
      args.length === 1 ? [args[0]] : Array.from(args)

    const setArgs = args =>
      args.length === 1 ? [args[0]] : [args[0], args[1]]

    const chain = (proxy, promise) => {
      const base = Promise.resolve(promise)
      const append = (method, args, target) => chain(
        proxy,
        base.then(() =>
          proxy._call(method, args || [], target || 'socket')
        )
      )
      const api = Object.assign(base, {
        connect: (...args) => append('connect', connectArgs(args)),
        disconnect: () => append('disconnect', []),
        emit: (...args) => append('emit', args),
        send: (...args) => append('send', args),
        set: (...args) => append('set', setArgs(args)),
        call(method, args, target) {
          validateCallArgs(args)

          return append(method, args || [], target || 'socket')
        },
        managerCall(method, args) {
          validateCallArgs(args)

          return append(method, args || [], 'manager')
        },
        close: () => chain(proxy, base.then(() => proxy.close()))
      })

      return new Proxy(api, {
        get: (target, property) => {
          if (property in target) {
            const value = target[property]

            return typeof value === 'function' ? value.bind(target) : value
          }

          if (typeof property !== 'string')
            return undefined

          return (...args) => append(property, args)
        }
      })
    }

    const proxyFor = core => new Proxy(core, {
      get: (target, property) => {
        if (property === 'then')
          return undefined

        if (property in target)
          return target[property]

        if (typeof property !== 'string')
          return undefined

        return (...args) => target.call(property, args)
      }
    })

    class SocketIOWorkerCore {
      constructor(options = {}) {
        this.src = options.src || 'socketio-worker.js'
        this.lib = options.lib || null
        this.options = options.options || {}
        this._callTimeout = options.timeout || CALL_TIMEOUT
        this._nextId = 1
        this._calls = {}
        this._listeners = {}
        this._terminated = false
        this._workerFailure = null
        this.connected = false
        this.disconnected = true
        this.active = false
        this.id = null
        this.transport = null
        this.reconnecting = false
        this.readyState = null

        try {
          this.worker = options.worker || new Worker(this.src)
          this.worker.onmessage = event => this._handleMessage(event)
          this.worker.onerror = event =>
            this._handleWorkerFailure('proxy:worker_error', event, false)
          this.worker.onmessageerror = event =>
            this._handleWorkerFailure('proxy:message_error', event, true)
        } catch (error) {
          this.worker = null
          this._terminated = true
          this._workerFailure = serializeError(error)
        }

        const config = { options: this.options }

        if (this.lib)
          config.lib = this.lib

        if (options.url !== undefined)
          config.url = options.url

        this.ready = this._workerFailure
          ? Promise.reject(makeError(this._workerFailure))
          : this._call('__configure', [config])
      }

      connect(...args) { return this._chain('connect', connectArgs(args)) }
      disconnect() { return this._chain('disconnect', []) }
      emit(...args) { return this._chain('emit', args) }
      send(...args) { return this._chain('send', args) }
      set(...args) { return this._chain('set', setArgs(args)) }

      call(method, args, target) {
        validateCallArgs(args)

        return this._chain(method, args || [], target || 'socket')
      }

      managerCall(method, args) {
        validateCallArgs(args)

        return this._chain(method, args || [], 'manager')
      }

      on(event, handler) {
        if (!this._listeners[event])
          this._listeners[event] = []

        this._listeners[event].push(handler)

        return this
      }

      off(event, handler) {
        const listeners = this._listeners[event]

        if (!listeners)
          return this

        if (!handler) {
          delete this._listeners[event]
          return this
        }

        this._listeners[event] = listeners.filter(c => c !== handler)

        return this
      }

      terminate() {
        if (this._terminated)
          return this

        const error = {
          name: 'Error',
          message: 'Socket.IO worker: terminated'
        }

        this._terminated = true
        this._workerFailure = error
        this._failAllCalls(error)

        if (this.worker && typeof this.worker.terminate === 'function')
          this.worker.terminate()

        return this
      }

      close() {
        if (this._terminated)
          return Promise.resolve(this)

        return this.disconnect()
          .catch(() => null)
          .then(() => {
            this.terminate()
            return this
          })
      }

      _chain(method, args, target) {
        return chain(
          this,
          this._call(method, args || [], target || 'socket')
        )
      }

      _call(method, args, target) {
        const id = this._nextId++
        const message = new MethodInvocation(id, target, method, args)
        let payload

        if (this._workerFailure)
          return Promise.reject(makeError(this._workerFailure))

        if (this._terminated || !this.worker)
          return Promise.reject(new Error('Socket.IO worker: terminated'))

        try {
          payload = message.toJSON()
          assertJsonSafe(payload, 'Socket.IO worker call')
        } catch (error) {
          return Promise.reject(error)
        }

        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            delete this._calls[id]
            this._cancelCall(id, method)
            reject(new Error(`Socket.IO worker call: timed out: ${method}`))
          }, this._callTimeout)

          this._calls[id] = { resolve, reject, timer }

          try {
            this.worker.postMessage(payload)
          } catch (error) {
            this._rejectCall(id, serializeError(error))
          }
        })
      }

      _cancelCall(id, method) {
        if (this._terminated || !this.worker)
          return

        try {
          this.worker.postMessage(new Cancellation(id, method).toJSON())
        } catch {
          // call already rejected; cancellation is best-effort
        }
      }

      _handleMessage(event) {
        const message = event.data || {}

        if (message.channel === 'call')
          return this._handleCallResponse(message)

        if (message.channel === 'update')
          return this._handleUpdate(message)

        if (message.channel === 'socket')
          return this._handleSocketMessage(message)
      }

      _handleCallResponse(message) {
        const call = this._calls[message.id]

        if (!call)
          return

        clearTimeout(call.timer)
        delete this._calls[message.id]

        if (message.ok)
          call.resolve(message.result)
        else
          call.reject(makeError(message.error))
      }

      _handleUpdate(message) {
        const reason = VANILLA_REASONS.includes(message.reason)
          ? message.reason
          : `proxy:${message.reason}`

        Object.assign(this, message.patch || {})
        this._emitLocal(reason, message.patch || {}, message)
      }

      _handleSocketMessage(message) {
        this._emitLocal(message.event, ...(message.args || []))
      }

      _handleWorkerFailure(reason, raw, isMessageError) {
        if (this._terminated)
          return

        const serialized = synthesizeFailure(raw, isMessageError)

        this._terminated = true
        this._workerFailure = serialized
        this._failAllCalls(serialized)

        if (this.worker && typeof this.worker.terminate === 'function')
          this.worker.terminate()

        this._emitLocal(reason, raw)
      }

      _rejectCall(id, error) {
        const call = this._calls[id]

        if (!call)
          return

        clearTimeout(call.timer)
        delete this._calls[id]
        call.reject(makeError(error))
      }

      _failAllCalls(error) {
        for (const id of Object.keys(this._calls))
          this._rejectCall(id, error)
      }

      _emitLocal(event, ...args) {
        const listeners = this._listeners[event] || []

        for (const handler of listeners.slice()) {
          try {
            handler.apply(this, args)
          } catch (error) {
            console.error(
              `Socket.IO worker listener for "${event}" threw:`, error
            )
          }
        }
      }
    }

    function SocketIOWorker(options) {
      return proxyFor(new SocketIOWorkerCore(options))
    }

    SocketIOWorker.prototype = SocketIOWorkerCore.prototype

    const noop = () => {}

    const isBinary = value =>
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value) ||
      (typeof Blob !== 'undefined' && value instanceof Blob)

    const wireReplacer = (key, value) => {
      if (isBinary(value))
        throw new TypeError(
          'Socket.IO emit: binary is not supported by the worker transport'
        )

      return value
    }

    // Mirror Socket.IO's wire encoding on the main thread: drop functions and
    // `undefined`, honour `toJSON()`, surface cycles, reject binary loudly. The
    // result is structured-clone-safe, so postMessage cannot throw.
    const toWire = value => JSON.parse(JSON.stringify(value, wireReplacer))

    const socketArgs = (event, args) => {
      if (event === 'connect')
        return []

      if (event === 'disconnect')
        return [args[1]?.value]

      if (event === 'connect_error')
        return [makeError(args[1]?.value)]

      return args
    }

    const managerArgs = (event, args) => {
      if (event === 'reconnect_error')
        return [makeError(args[1]?.value)]

      if (event === 'reconnect_failed')
        return []

      return [args[1]?.value]
    }

    class EventBridge {
      constructor(core, coreEvent, mapArgs) {
        this._core = core
        this._coreEvent = coreEvent
        this._mapArgs = mapArgs
        this._listeners = {}
        this._bound = {}
      }

      on(event, handler) {
        if (!this._listeners[event])
          this._listeners[event] = []

        this._listeners[event].push(handler)
        this._bind(event)
      }

      once(event, handler) {
        const wrapper = (...args) => {
          this.off(event, wrapper)
          handler(...args)
        }

        wrapper.listener = handler
        this.on(event, wrapper)
      }

      off(event, handler) {
        const listeners = this._listeners[event]

        if (!listeners)
          return

        if (!handler)
          delete this._listeners[event]
        else
          this._listeners[event] = listeners
            .filter(fn => fn !== handler && fn.listener !== handler)
      }

      _bind(event) {
        if (this._bound[event])
          return

        this._bound[event] = (...args) => {
          const mapped = this._mapArgs(event, args)

          for (const fn of (this._listeners[event] || []).slice())
            fn(...mapped)
        }

        this._core.on(this._coreEvent(event), this._bound[event])
      }
    }

    class ManagerFacade {
      constructor(core, socket) {
        this._events =
          new EventBridge(core, event => `proxy:${event}`, managerArgs)

        this.opts = {
          get query() { return socket._query },
          set query(value) { socket._query = value }
        }
      }

      on(event, handler) {
        this._events.on(event, handler)

        return this
      }

      once(event, handler) {
        this._events.once(event, handler)

        return this
      }

      off(event, handler) {
        this._events.off(event, handler)

        return this
      }
    }

    class SocketFacade {
      constructor(url, options) {
        const settings = { ...options }
        const auto = settings.autoConnect !== false

        settings.autoConnect = false

        this._url = url
        this._auth = settings.auth ?? undefined
        this._query = settings.query ?? undefined
        this._started = false
        this._buffer = []
        this._core = new SocketIOWorkerCore({
          src: io.config.src,
          lib: io.config.lib,
          timeout: io.config.timeout,
          options: settings
        })
        this._events = new EventBridge(this._core, event => event, socketArgs)
        this.io = new ManagerFacade(this._core, this)

        if (auto)
          this.connect()
      }

      get id() { return this._core.id }
      get connected() { return this._core.connected }
      get disconnected() { return this._core.disconnected }
      get active() { return this._core.active }
      get recovered() { return this._core.recovered }

      get auth() { return this._auth }
      set auth(value) {
        this._auth = value
      }

      on(event, handler) {
        this._events.on(event, handler)

        return this
      }

      once(event, handler) {
        this._events.once(event, handler)

        return this
      }

      off(event, handler) {
        this._events.off(event, handler)

        return this
      }

      connect() {
        this._started = true

        const values = {}

        if (this._auth != null)
          values.auth = toWire(this._auth)

        if (this._query != null)
          values.query = toWire(this._query)

        if (Object.keys(values).length)
          this._core.set(values).catch(noop)

        this._core.connect(this._url).catch(noop)
        this._buffer.splice(0).forEach(m => this._send(m.event, m.data, m.ack))

        return this
      }

      disconnect() {
        this._core.disconnect().catch(noop)

        return this
      }

      emit(event, ...args) {
        const ack = typeof args.at(-1) === 'function' ? args.pop() : null
        const data = toWire(args)

        if (this._started)
          this._send(event, data, ack)
        else
          this._buffer.push({ event, data, ack })

        return this
      }

      close() {
        return this._core.close()
      }

      _send(event, data, ack) {
        if (ack)
          this._core.call('emitWithAck', [event, ...data])
            .then(reply => ack(reply))
            .catch(noop)
        else
          this._core.emit(event, ...data).catch(noop)
      }
    }

    function io(url, options) {
      return new SocketFacade(url, options || {})
    }

    io.config = { src: 'socketio-worker.js', lib: null, timeout: CALL_TIMEOUT }

    root.SocketIOWorker = SocketIOWorker
    root.io = io
  }

  function installWorker() {
    const state = {
      lib: null,
      libraryLoaded: false,
      socket: null,
      detachSocket: null,
      refreshSocketListeners: null,
      connecting: null,
      connectingId: null,
      abortConnect: null,
      callTimeout: CALL_TIMEOUT,
      options: {}
    }

    const post = message => root.postMessage(message.toJSON())

    const loadLibrary = lib => {
      if (state.libraryLoaded)
        return

      state.lib = lib || state.lib
      if (!state.lib)
        throw new Error('Socket.IO worker library: lib is required')

      importScripts(state.lib)

      if (typeof root.io !== 'function')
        throw new Error('Socket.IO worker library: io() was not exposed')

      state.libraryLoaded = true
    }

    const serializeMaybeError = value =>
      value instanceof Error ? serializeError(value) : value

    const snapshot = () => {
      const socket = state.socket
      const manager = socket?.io
      const transport = manager?.engine?.transport

      return {
        id: socket?.id || null,
        connected: Boolean(socket?.connected),
        disconnected: socket?.disconnected ?? true,
        active: Boolean(socket?.active),
        recovered: Boolean(socket?.recovered),
        transport: transport?.name || null,
        reconnecting: Boolean(manager?._reconnecting),
        readyState: manager?._readyState || null
      }
    }

    const postUpdate = (reason, value) => {
      post(new PropertyUpdate(reason, snapshot(), value))
    }

    const attachSocket = socket => {
      const onAnyHandler = (event, ...args) => {
        try {
          assertJsonSafe(args, 'socket event args')

          post(new SocketEvent(event, args))
        } catch (error) {
          error.context = { event }
          postUpdate('socket_event_error', serializeError(error))
        }
      }

      const socketHandlers = {}
      let attached = false

      for (const event of ['connect', 'disconnect', 'connect_error']) {
        const handler = value =>
          postUpdate(event, serializeMaybeError(value))

        socketHandlers[event] = handler
      }

      const managerEvents = [
        'reconnect_attempt',
        'reconnect',
        'reconnect_error',
        'reconnect_failed',
        'ping',
        'error'
      ]

      const managerHandlers = {}

      for (const event of managerEvents) {
        const handler = value =>
          postUpdate(event, serializeMaybeError(value))

        managerHandlers[event] = handler
      }

      const attach = () => {
        if (attached)
          return

        attached = true
        socket.onAny(onAnyHandler)

        for (const [event, handler] of Object.entries(socketHandlers))
          socket.on(event, handler)

        for (const [event, handler] of Object.entries(managerHandlers))
          socket.io.on(event, handler)
      }

      const detach = () => {
        if (!attached)
          return

        attached = false
        socket.offAny(onAnyHandler)

        for (const [event, handler] of Object.entries(socketHandlers))
          socket.off(event, handler)

        for (const [event, handler] of Object.entries(managerHandlers))
          socket.io.off(event, handler)
      }

      attach()

      return {
        detach,
        refresh() {
          detach()
          attach()
        }
      }
    }

    const createSocket = (url, options) => {
      loadLibrary(state.lib)

      if (!url && !state.socket)
        throw new TypeError('Socket.IO socket: URL is required')

      if (!url)
        return state.socket

      if (state.socket) {
        if (state.detachSocket)
          state.detachSocket()

        state.socket.disconnect()
      }

      const merged = {
        autoConnect: false,
        ...state.options,
        ...(options || {})
      }

      state.options = jsonCopy(merged)
      state.socket = root.io(url, merged)
      const bridge = attachSocket(state.socket)

      state.detachSocket = bridge.detach
      state.refreshSocketListeners = bridge.refresh
      postUpdate('created')

      return state.socket
    }

    const retireSocket = socket => {
      if (state.socket === socket) {
        if (state.detachSocket)
          state.detachSocket()

        state.socket = null
        state.detachSocket = null
        state.refreshSocketListeners = null
      }

      socket.once('connect', () => socket.disconnect())
      socket.disconnect()

      if (typeof socket.io?.disconnect === 'function')
        socket.io.disconnect()
      else if (typeof socket.io?._close === 'function')
        socket.io._close()
    }

    const configure = config => {
      const cfg = config || {}

      state.lib = cfg.lib || state.lib
      state.options = jsonCopy(cfg.options || {})
      state.callTimeout = cfg.timeout || CALL_TIMEOUT
      loadLibrary(state.lib)

      if (cfg.url)
        createSocket(cfg.url, cfg.options)

      return snapshot()
    }

    const connect = (url, options, id) => {
      if (state.connecting)
        throw new Error('Socket.IO connect: already in progress')

      const socket = createSocket(url, options)

      if (socket.connected)
        return Promise.resolve(snapshot())

      state.connecting = new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          state.connecting = null
          state.connectingId = null
          state.abortConnect = null
          socket.off('connect', onConnect)
          socket.off('connect_error', onError)
        }

        const onConnect = () => {
          cleanup()
          resolve(snapshot())
        }

        const onError = error => {
          cleanup()
          reject(error)
        }

        const timer = setTimeout(() => {
          cleanup()
          retireSocket(socket)
          reject(new Error('Socket.IO connect: timed out'))
        }, state.callTimeout)

        state.connectingId = id
        state.abortConnect = reason => {
          cleanup()
          retireSocket(socket)
          reject(new Error(`Socket.IO connect: aborted by ${reason}`))
        }

        socket.once('connect', onConnect)
        socket.once('connect_error', onError)
        socket.connect()
      })

      return state.connecting
    }

    const cancelCall = message => {
      if (
        message.method === 'connect' &&
        state.connectingId === message.id &&
        state.abortConnect
      )
        state.abortConnect('timeout')
    }

    const BLOCKED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

    const pathParts = path => {
      if (typeof path !== 'string')
        throw new TypeError('Socket.IO set path: expected string')

      const parts = path.split('.')

      if (parts.some(part => !part || BLOCKED_SEGMENTS.has(part)))
        throw new RangeError('Socket.IO set path: invalid segment')

      return parts
    }

    const setPath = (target, parts, value) => {
      const parent = parts.slice(0, -1).reduce((object, key) => {
        if (object == null || object[key] == null)
          throw new TypeError('Socket.IO set path: parent does not exist')

        if (typeof object[key] !== 'object')
          throw new TypeError('Socket.IO set path: crosses a non-object value')

        return object[key]
      }, target)

      parent[parts.at(-1)] = jsonCopy(value)
    }

    const setOptionPath = (options, parts, value) => {
      const parent = parts.slice(0, -1).reduce((object, key) => {
        if (object[key] == null)
          object[key] = {}

        if (typeof object[key] !== 'object')
          throw new TypeError('Socket.IO set path: crosses a non-object value')

        return object[key]
      }, options)

      parent[parts.at(-1)] = jsonCopy(value)
    }

    const setSocketPath = (parts, value) => {
      if (parts[0] === 'query')
        return setPath(state.socket.io.opts, parts, value)

      setPath(state.socket, parts, value)
    }

    const setOptionsPath = (options, parts, value) => {
      if (parts[0] === 'io' && parts[1] === 'opts')
        return setOptionPath(options, parts.slice(2), value)

      setOptionPath(options, parts, value)
    }

    const setMutableOptionPath = (path, value) => {
      const parts = pathParts(path)

      if (state.socket)
        setSocketPath(parts, value)
      else
        setOptionsPath(state.options, parts, value)
    }

    const setMutableOptions = values => {
      if (!isPlainObject(values))
        throw new TypeError('Socket.IO set object: expected plain object')

      const copied = jsonCopy(values)
      const paths = Object.keys(copied)

      for (const path of paths)
        pathParts(path)

      if (state.socket) {
        for (const path of paths)
          setMutableOptionPath(path, copied[path])
      } else {
        const options = jsonCopy(state.options)

        for (const path of paths)
          setOptionsPath(options, pathParts(path), copied[path])

        state.options = options
      }
    }

    const setMutable = (...args) => {
      if (args.length === 1 && isPlainObject(args[0]))
        setMutableOptions(args[0])
      else
        setMutableOptionPath(args[0], args[1])

      postUpdate('set')

      return snapshot()
    }

    const LISTENER_MUTATORS = new Set([
      'off',
      'offAny',
      'offAnyOutgoing',
      'removeAllListeners',
      'removeEventListener',
      'removeListener'
    ])

    const mutatesListeners = method => LISTENER_MUTATORS.has(method)

    const callMethod = (target, method, args) => {
      if (!target || typeof target[method] !== 'function')
        throw new TypeError(`Socket.IO method: unknown: ${method}`)

      const result = target[method].apply(target, args || [])

      if (mutatesListeners(method) && state.refreshSocketListeners)
        state.refreshSocketListeners()

      return result
    }

    const disconnectSocket = () => {
      if (state.abortConnect) {
        state.abortConnect('disconnect')
        return snapshot()
      }

      state.socket.disconnect()
      return snapshot()
    }

    const socketCalls = {
      __configure: message => configure(message.args?.[0]),
      connect: message => connect(
        message.args?.[0],
        message.args?.[1],
        message.id
      ),
      set: message => setMutable.apply(null, message.args || [])
    }

    const callSocketMethod = message => {
      if (socketCalls[message.method])
        return socketCalls[message.method](message)

      if (!state.socket)
        throw new Error('Socket.IO socket: has not been created')

      if (message.method === 'disconnect')
        return disconnectSocket()

      return callMethod(state.socket, message.method, message.args)
    }

    const callManagerMethod = message => {
      const socket = state.socket

      if (!socket)
        throw new Error('Socket.IO socket: has not been created')

      return callMethod(socket.io, message.method, message.args)
    }

    const normalizeResult = result => {
      if (
        result === state.socket ||
        result === state.socket?.io
      )
        return snapshot()

      return result
    }

    const respond = (id, ok, value) => {
      const message = ok
        ? new MethodResult(id, true, normalizeResult(value))
        : new MethodResult(id, false, value)

      try {
        post(message)
      } catch (error) {
        try {
          post(new MethodResult(id, false, error))
        } catch {
          // unable to surface the failure; drop silently
        }
      }
    }

    root.onmessage = event => {
      const message = event.data || {}

      if (message.channel === 'cancel')
        return cancelCall(message)

      if (message.channel !== 'call')
        return

      Promise.resolve()
        .then(() => message.target === 'manager'
          ? callManagerMethod(message)
          : callSocketMethod(message)
        )
        .then(result => respond(message.id, true, result))
        .catch(error => respond(message.id, false, error))
    }
  }

  if (isWorkerScope())
    installWorker()
  else
    installMain()
})(typeof self !== 'undefined' ? self : this)
