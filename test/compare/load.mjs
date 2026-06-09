// Comparative LOAD: identical emit workloads through real `io` and the facade,
// measuring the MAIN-THREAD cost (ms/emit + long-tasks) each adds. The delta is
// what the worker bridge costs over a direct client.
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node load.mjs
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
import { start } from './server.mjs'

const REGIMES = [
  { label: 'high-freq small  (200 B  x 2000)', n: 2000, bytes: 200 },
  { label: 'medium           (5 KB   x 1000)', n: 1000, bytes: 5_000 },
  { label: 'large paste      (1 MB   x 20)  ', n: 20, bytes: 1_000_000 }
]

const srv = await start()
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage()
page.on('pageerror', e => console.log('pageerror:', e.message))

const out = []
try {
  await page.goto(srv.url + '/page.html', { waitUntil: 'load' })
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 })

  for (const rg of REGIMES) {
    const real = await page.evaluate(o => window.benchLoad('real', o), rg)
    const facade = await page.evaluate(o => window.benchLoad('facade', o), rg)
    out.push({ regime: rg.label, real, facade })
  }
} catch (e) { console.log('FAILED:', e.message) }

await page.close()
await browser.close()
await srv.stop()

console.log(`\n===== LOAD: facade vs real io (main-thread cost) — ${browser.version?.() || ''} =====`)
for (const r of out) {
  const f = r.facade, i = r.real
  const x = (f.msPerEmit / i.msPerEmit)
  console.log(`\n## ${r.regime}`)
  console.log(`  real   : ${i.msPerEmit.toFixed(4)} ms/emit | total ${i.totalMainMs.toFixed(1)} ms | longtasks ${i.longTasks} (max ${i.maxLongTaskMs.toFixed(0)} ms)`)
  console.log(`  facade : ${f.msPerEmit.toFixed(4)} ms/emit | total ${f.totalMainMs.toFixed(1)} ms | longtasks ${f.longTasks} (max ${f.maxLongTaskMs.toFixed(0)} ms)`)
  console.log(`  delta  : ${x.toFixed(2)}x main-thread ms/emit ; +${(f.totalMainMs - i.totalMainMs).toFixed(1)} ms total`)
}
writeFileSync(new URL('./load-results.json', import.meta.url), JSON.stringify(out, null, 2))
console.log('\nwrote load-results.json')
process.exit(0)
