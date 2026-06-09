# `test/compare` — facade vs real `io`

A self-contained harness that runs **identical** workloads through the real
Socket.IO client (`io`) and the worker `io()` facade and reports the **delta**
(`load`/`storm` drive a real browser; `fuzz` runs in Node). It is **not** part of
`npm test` (which is Node-only and pristine) and adds no dependencies to the main
package — it has its own `package.json`.

## Why separate

The Node suite proves *correctness* but cannot measure what actually matters for
the migration: real **main-thread cost** (real `structuredClone`, a real worker
thread) and real **event timing**. And delivery/ordering/reconnection are
Socket.IO's job, not ours — so testing them in Node would grade the framework, not
the bridge. Running the **same** workload through `io` and the facade and
subtracting cancels Socket.IO's baseline; the remainder is what the bridge costs.

## Run

```bash
cd test/compare
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm install
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run load    # main-thread ms/emit + long-tasks -> load-results.json
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run storm   # reconnect-event order + timing  -> storm-results.json
npm run fuzz                                              # differential wire-parity (fast-check, Node)
```

## What each measures

- **load** — for small/medium/large payload regimes: synchronous main-thread
  `ms/emit` and any `>50ms` long-tasks, for `io` vs facade. The large regime stands
  in for an `exportJSON`/base64-image emit; the small regime for pointer/viewport
  spray.
- **storm** — drives a clean drop (reconnect latency) and a server outage, capturing
  the `connect_error` / `reconnect_error` / `reconnect_failed` sequence + timing for
  both clients, to confirm the facade preserves the ordering and to quantify the
  latency it adds.
- **fuzz** — property-based (fast-check) differential check: random/adversarial
  values must reach the wire identically to a real `io` client
  (`JSON.parse(JSON.stringify(...))`), or throw exactly when io would; any failure
  shrinks to a minimal counterexample. Binary is excluded (realm-specific — see the
  note in `fuzz.mjs`).

The server is a generic echo/sink (no app events); it serves the real
`socketio-worker.js` and the vendored browser client, so both paths exercise the
actual code under test.
