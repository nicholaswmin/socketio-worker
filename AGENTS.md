# Socket.IO Worker

## Overview

Generic Socket.IO proxy that keeps the real client inside a classic Worker.  
Transport, heartbeat, ping/pong, and reconnect timers stay off the main
thread.  

## Work Rules

- You **MUST** write tests first.  
- You **MUST** treat the test suite as slightly more important than source.  
  Keep it pristine, uniform, high-signal, and free of junk tests.  
  Do not tolerate deviations from this.  
- You **MUST** match existing patterns and idioms down to the last detail.  
- You **MUST** surface errors properly.  
  Never swallow an error.  
- You **MUST** double-check and review your work.  
  No dead files, inconsistencies, or drift should remain.  

## Project Scope

- Keep this package generic.  
  No app-specific events, auth schemes, routes, or reconnect policy.  
- Pass the worker script and Socket.IO client URLs explicitly via `io.config`
  (`src` / `lib`). Page script tags are not inspected.  
- The public surface is `io()` — a Socket.IO-client drop-in. Keep it faithful to
  the Socket.IO client API.  
- For code and domain terms, prefer Socket.IO terminology where possible.  
  Do not thrash terminology unnecessarily.  

```js
// ✅ Keep Socket.IO names
proxy.on('connect_error', handler)
await proxy.managerCall('reconnectionAttempts', [3])

// ❌ Avoid renaming established concepts
proxy.on('connection_failed', handler)
await proxy.managerCall('retryLimit', [3])
```

## Runtime Contract

- Payloads, call args, and method results follow Socket.IO JSON serialization.  
  `undefined` keeps Socket.IO parity.  
  Array slots become `null`; object fields are omitted.  
- Binary data, functions, DOM nodes, class instances, symbols, and cycles do not
  cross the worker boundary as-is.  
  The `io()` facade normalises emit args / `auth` / `query` to Socket.IO's wire
  form first (functions and `undefined` dropped, `toJSON()` honoured); cycles and
  binary throw.  
- Callback acks stay on the main thread: a trailing function on `io()` `emit()`
  is invoked with the server reply (bridged via `emitWithAck`).  
- Direct proxy mutation is local only.  
  Use `set(path, value)` or `set(object)` for worker-owned mutation.  
- Timed-out `connect()` calls must not leave a late visible connection.  
- Bridge-owned listeners must survive listener-mutating methods.  
  Examples: `offAny()` and `removeAllListeners()`.  

## Message Channels

```text
call   -> RPC request/response by id
cancel -> best-effort abort for timed-out connect()
update -> worker-owned state patch
socket -> forwarded server event
```

`WorkerMessage` subclasses are local builders only.  
Only their plain `.toJSON()` payloads cross `postMessage()`.  

## Event Naming

```text
connect / disconnect / connect_error -> preserve Socket.IO names
proxy:*                              -> bridge/meta events
server:event                         -> forwarded unchanged
```

> [!IMPORTANT]
> `proxy:*` events are bridge-internal. Do not document or stabilize.
> May be renamed or removed without notice.

## Error Taxonomy

```text
TypeError   -> invalid shape
RangeError  -> invalid value
SyntaxError -> native JSON parse failure
Error       -> runtime/component failure
```

## Code Guidelines

- You **MUST** keep code direct and close to the Socket.IO concepts.  
- You **MUST** avoid intermediates unless they remove real complexity.  
- You **MUST** use concise names that carry their actual role.  
- You **SHOULD** prefer functional array methods when they stay readable.  

✅ **Good Way**

```js
this._listeners[event] = listeners.filter(listener => listener !== handler)
```

❌ **Bad Way**

```js
const nextListeners = []

for (const listener of listeners) {
  if (listener !== handler)
    nextListeners.push(listener)
}

this._listeners[event] = nextListeners
```

✅ **Good Way**

```js
return callMethod(socket.io, message.method, message.args)
```

❌ **Bad Way**

```js
const manager = socket.io
const method = message.method
const args = message.args

return callMethod(manager, method, args)
```

## Testing Guidelines

- You **MUST** run `node --test` with `--test-concurrency=1`.  
  Tests share VM worker hosts and timing-sensitive reconnect flows that race
  under file concurrency.  
- You **MUST** nest tests as `subject -> #method -> context -> behavior`.  
- You **MUST** put shared **arrange + act** in the nearest owning
  `t.beforeEach()`.  
- You **MUST** keep leaf `t.test()` blocks assertion-focused.  
- You **MUST** attach fixtures/results to `t`, not outer variables.  
- You **MUST** use `partialDeepStrictEqual()` whenever possible.  
  Snapshots, payload-shaped values, and any value with more than one field.  

```js
// ❌ scalar sprawl
t.assert.strictEqual(snapshot.connected, true)
t.assert.strictEqual(snapshot.transport, 'websocket')
t.assert.strictEqual(snapshot.id, socket.id)

// ✅ structural
t.assert.partialDeepStrictEqual(snapshot, {
  connected: true,
  transport: 'websocket',
  id: socket.id
})
```

- You **MUST** keep assertions cohesive: one behavior claim per spec.  
  Multiple assertions are fine when they prove the same claim.  
  Split when the spec name can no longer cover every possible failure.  

```js
// ✅ cohesive — both assertions support "rejects with typed missing url error"
await t.test('rejects with typed missing url error', async t => {
  const error = await t.proxy.connect().catch(err => err)
  t.assert.strictEqual(error.name, 'TypeError')
  t.assert.match(error.message, /missing/i)
})

// ❌ mixed claims — name cannot describe a transport failure
await t.test('proxy works', async t => {
  t.assert.strictEqual(t.proxy.connected, true)
  await t.assert.rejects(() => t.proxy.connect('bad'))
  t.assert.strictEqual(t.proxy.transport, 'websocket')
})
```

- You **MUST** match error/message keywords with regex, not exact strings.  
  `/insufficient/i` over `'Insufficient funds in account'`.  

```js
// ❌ brittle — breaks on any rephrase
t.assert.strictEqual(error.message, 'connect_error: forbidden')

// ✅ keyword survives rephrasing
t.assert.match(error.message, /forbidden/i)
```

- You **SHOULD** prefer `t.mock.fn()` / `t.mock.method()` over custom mocks.  
  Reach for a custom mock only when the built-in API cannot express the seam.  

```js
// ✅ built-in spy
t.beforeEach(t => {
  t.onConnect = t.mock.fn()
  t.proxy.on('connect', t.onConnect)
})

await t.test('fires connect once', t => {
  t.assert.strictEqual(t.onConnect.mock.callCount(), 1)
})

// ❌ custom spy when t.mock.fn() would do
let calls = 0
t.proxy.on('connect', () => calls++)
```

Test fixture roles:

```text
test/main.test.js      -> real Socket.IO server flows
test/io.test.js        -> io() facade (Socket.IO-client drop-in) behavior
test/proxy.test.js     -> proxy / worker bridge mechanics
test/utils/index.js    -> core Fixture, server helper, shared exports
test/utils/socket.io.js -> vendored Socket.IO browser client for the VM worker
test/utils/worker.js   -> shared VM WorkerHost
```

> [!TIP]
> - Each `Fixture` loads the worker script into its own VM context.
> - `fixture.close()` terminates every worker it spawned — safe across tests.

### Test Utilities

- You **MUST** use the `Fixture` class from `#test/utils` for proxy/element
  setup. Bypassing it causes drift across test files.  

```js
// ✅ go through Fixture
import { Fixture } from '#test/utils'
t.beforeEach(t => {
  t.fixture = new Fixture()
  t.Proxy = t.fixture.load()
  t.proxy = new t.Proxy({ src, lib })
})

// ❌ bypassing — forks setup across files
t.beforeEach(t => {
  const ctx = vm.createContext({ ... })
  vm.runInContext(workerSrc, ctx)
  t.proxy = ctx.SocketIOWorker
})
```

- You **MUST NOT** add methods, properties, or options to `Fixture` without
  explicit user approval. Every addition becomes a contract every test
  depends on. Compose around it instead.  

```js
// ❌ growing Fixture for one test's need
class Fixture {
  loadWithAuth(token) { /* ... */ }   // do not add
  withMockServer()    { /* ... */ }   // do not add
}

// ✅ compose at the call site
t.beforeEach(t => {
  t.fixture = new Fixture()
  t.Proxy = t.fixture.load()
  t.proxy = new t.Proxy({ src, lib })
  t.proxy.set({ auth: { token: 'ok' } })
})
```
- You **MUST** use existing `#test/utils` fixtures before adding a helper.  
- You **MUST NOT** add tests that target `test/utils` directly.  
  Cover utility behavior through the owning feature tests.  
- You **MUST** keep behavior-specific setup inline until it is repeated.  
- You **MUST** keep helpers generic.  
  Tests own the behavior claim.  
- You **MUST NOT** pass `t` into helper functions.  

✅ **Good Way**

```js
import { test } from 'node:test'
import { Fixture, once, plain, server } from '#test/utils'

test('SocketIOWorker', async t => {
  t.beforeEach(async t => {
    t.server = await server()
    t.fixture = new Fixture()
    t.Proxy = t.fixture.load()
    t.proxy = new t.Proxy({ src, lib })
  })

  t.afterEach(async t => {
    await t.proxy?.disconnect().catch(() => null)
    t.proxy?.terminate()
    t.fixture.close()
    await t.server?.close()
  })

  await t.test('#connect', async t => {
    const [[socket], snapshot] = await Promise.all([
      once(t.server.io, 'connection'),
      t.proxy.connect(t.server.url)
    ])

    t.assert.partialDeepStrictEqual(plain(snapshot), { connected: true })
  })
})
```

❌ **Bad Way**

```js
// hides setup, action, and assertion boundaries
t.context = await setupHappyConnectedSocket(t)

// domain-specific one-off helper
const socket = await connectAdminRoomWithBlueQuery()
```

✅ **Good Way**

```js
import { test } from 'node:test'
import { Fixture, plain, server } from '#test/utils'

test('SocketIOWorker', async t => {
  t.beforeEach(t => {
    t.fixture = new Fixture()
    t.Proxy = t.fixture.load()
  })

  t.afterEach(async t => {
    await t.proxy?.disconnect().catch(() => null)
    t.proxy?.terminate()
    t.fixture.close()
    await t.server?.close()
  })

  await t.test('#connect', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({ src, lib })
    })

    await t.test('with valid auth', async t => {
      t.beforeEach(async t => {
        t.server.io.use((socket, next) =>
          socket.handshake.auth.token === 'ok'
            ? next()
            : next(new Error('forbidden'))
        )

        t.snapshot = plain(await t.proxy
          .set({ auth: { token: 'ok' } })
          .connect(t.server.url))
      })

      await t.test('returns connected snapshot', t => {
        t.assert.partialDeepStrictEqual(t.snapshot, {
          connected: true,
          transport: 'websocket'
        })
      })

      await t.test('updates proxy state', t => {
        t.assert.partialDeepStrictEqual(t.proxy, {
          connected: true
        })
      })
    })
  })
})
```

Shape:

```text
subject
└── #method
    └── context
        ├── beforeEach: arrange + act
        ├── behavior assertion
        └── behavior assertion
```

❌ **Bad Way**

```js
let proxy
let snapshot

test('connect works', async t => {
  const fixture = new Fixture()
  const Proxy = fixture.load()
  const s = await server()

  proxy = new Proxy({ src, lib })
  s.io.use((socket, next) => next())

  snapshot = await proxy.connect(s.url)

  t.assert.strictEqual(snapshot.connected, true)
  t.assert.strictEqual(proxy.connected, true)
  t.assert.strictEqual(snapshot.transport, 'websocket')

  await proxy.disconnect()
  proxy.terminate()
  await s.close()
  fixture.close()
})
```

Problems:

- Flat name hides subject/method/context.  
- Outer variables leak state.  
- Arrange, act, assertions, and teardown are mixed.  
- Multiple behavior claims are packed into one test.  
- Snapshot-shaped values use scalar assertion sprawl.  

## Review

Run before declaring work done.  

**Scope:**

- No app-specific events, auth schemes, routes, or reconnect policy.  
- `lib` URL passed explicitly; no script tag inspection.  
- Socket.IO terminology preserved; `proxy:*` stays bridge-internal.  

**Runtime:**

- Payloads cross the worker boundary as JSON-safe values only.  
- Worker-owned mutation goes through `set(path, value)` / `set(object)`.  
- Errors surface with name, message, stack — never swallowed.  
- Timed-out `connect()` does not leave a late visible connection.  
- Bridge listeners survive `offAny()` / `removeAllListeners()`.  

**Code:**

- Expressions over statements; no intermediates without cause.  
- Concise arrows, implicit return, `?.` / `??` over stacked guards.  
- Functional array methods over manual loops where readable.  
- No dead files, stale exports, or drift between code and docs.  

**Tests:**

- `node --test --test-concurrency=1` passes clean.  
- Shape: `subject -> #method -> context -> behavior`.  
- Arrange + act in the nearest owning `t.beforeEach()`.  
- Leaf `t.test()` blocks are assertion-focused.  
- Fixtures attached to `t`; no outer variables; no `t` into helpers.  
- `partialDeepStrictEqual()` on every multi-field value.  
- One behavior claim per spec; regex match for error messages.  
- `t.mock.fn()` over custom spies.  
- `t.afterEach`: `disconnect().catch()` → `terminate()` → `fixture.close()`
  → `server.close()`.  

**Docs:**

- README covers public surface only.  
- `proxy:*` events not documented as public API.  
- AGENTS.md changes match the rule they describe.  
