// Comparative STORM: drives both clients through (A) a clean server-side drop
// (reconnect latency) and (B) a server outage (the connect_error / reconnect_error
// / reconnect_failed sequence). Reports the order + relative timing each client
// sees, so we can confirm the facade preserves the ordering room-socket's
// debounced error capture depends on, and how much latency it adds.
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node storm.mjs
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
import { start } from './server.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const srv = await start()
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage()
page.on('pageerror', e => console.log('pageerror:', e.message))

let logs = { real: [], facade: [] }
try {
  await page.goto(srv.url + '/page.html', { waitUntil: 'load' })
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 })

  await page.evaluate(() => { window.makeStormClient('real'); window.makeStormClient('facade') })
  await page.waitForFunction(() => {
    const l = window.__stormLogs()
    return l.real.some(e => e.ev === 'connect') && l.facade.some(e => e.ev === 'connect')
  }, null, { timeout: 15000 })

  // Phase A — abrupt transport drop, server stays up: both should reconnect
  srv.dropTransport()
  await page.waitForFunction(() => {
    const l = window.__stormLogs()
    return l.real.some(e => e.ev === 'reconnect') && l.facade.some(e => e.ev === 'reconnect')
  }, null, { timeout: 8000 }).catch(() => {})

  // Phase B — outage: reconnects fail until attempts exhaust
  await srv.stop()
  await page.waitForFunction(() => {
    const l = window.__stormLogs()
    return l.real.some(e => e.ev === 'reconnect_failed') && l.facade.some(e => e.ev === 'reconnect_failed')
  }, null, { timeout: 8000 }).catch(() => {})
  await sleep(300)

  logs = await page.evaluate(() => window.__stormLogs())
} catch (e) { console.log('FAILED:', e.message) }

await page.close()
await browser.close()
try { await srv.stop() } catch (e) {}

const rel = log => {
  if (!log.length) return []
  const t0 = log[0].t
  return log.map(e => ({ ...e, dt: +(e.t - t0).toFixed(1) }))
}
const fmt = log => rel(log)
  .map(e => `      +${String(e.dt).padStart(7)} ms  ${e.ev}${e.isError === false ? ' (NOT Error!)' : ''}${e.reason ? ' reason=' + e.reason : ''}${e.msg ? ' msg="' + e.msg + '"' : ''}`)
  .join('\n')

console.log('\n===== STORM: reconnect-event timing =====')
for (const mode of ['real', 'facade']) {
  console.log(`\n## ${mode}`)
  console.log(fmt(logs[mode]))
}

const order = log => log.map(e => e.ev).filter(ev => ev !== 'reconnect_attempt')
console.log('\n## sequence (attempts elided)')
console.log('  real  :', order(logs.real).join(' -> '))
console.log('  facade:', order(logs.facade).join(' -> '))

writeFileSync(new URL('./storm-results.json', import.meta.url), JSON.stringify(logs, null, 2))
console.log('\nwrote storm-results.json')
process.exit(0)
