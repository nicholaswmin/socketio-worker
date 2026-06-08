# Socket.IO Worker

[![test][testb]][test]

socket.io running in a webworker.  
ensures timers/heartbeat mechanisms work regardless.  

## Usage

`io()` is a drop-in for the Socket.IO client: same API, but the real client runs
inside a classic Worker. Serve the Socket.IO browser client and the worker
script, then point the worker at both:

```html
<script src="/socketio-worker.js"></script>
```

```js
io.config = {
  src: '/socketio-worker.js',          // the worker script
  lib: '/socket.io/socket.io.js'       // the Socket.IO browser client
}

const socket = io('https://example.com', {
  autoConnect: false,
  transports: ['websocket']
})

socket.on('connect',       () => console.log(socket.id))
socket.on('disconnect',    reason => console.log(reason))
socket.on('connect_error', err => console.log(err.message))
socket.on('example:event', payload => console.log(payload))

socket.io.on('reconnect_attempt', attempt => console.log(attempt))

socket.auth = { token: 'foo' }
socket.io.opts.query = { room: 'bar' }
socket.connect()

socket.emit('example:event', { ok: true })
socket.emit('request-users', users => console.log(users)) // ack callback
```

The worker does not inspect page script tags; pass both URLs through
`io.config`. `src`/`lib`/`timeout` default to `socketio-worker.js` / `null` /
`20000`.

## Gotchas

- Emit args (and `auth` / `query`) are normalised to Socket.IO's wire form on the
  main thread before crossing into the worker: functions and `undefined` are
  dropped, `toJSON()` is honoured, array holes become `null`. This mirrors a real
  `socket.emit`, so anything that works against the Socket.IO client works here.  
- A **circular** payload throws a `TypeError`; **binary** (`Blob` / `ArrayBuffer`
  / typed arrays) is not supported by the worker transport and throws.  
- Ack callbacks are supported: a trailing function on `emit()` is kept on the main
  thread and invoked with the server's reply.  
- `socket.id` / `connected` / `disconnected` / `active` / `recovered` are
  snapshots synced from the worker.  
- `socket.io.*` (the `proxy:*` bridge events underneath) is internal and may
  change; use the Socket.IO-shaped manager events (`reconnect_attempt`, etc.).  
- `close()` tears the worker down for good (no Socket.IO equivalent);
  `disconnect()` just drops the connection.  

## Run tests

```bash
npm i
npm t
```

## Author

[@TheProfs][author]

## License

[MIT][mit]

[testb]: https://github.com/TheProfs/socketio-worker/actions/workflows/test.yml/badge.svg
[test]: https://github.com/TheProfs/socketio-worker/actions/workflows/test.yml
[author]: https://github.com/TheProfs
[mit]: https://opensource.org/licenses/MIT
