// Manual DOM harness runner for the Ultra pick inside the reasoning menu.
// Bundles the REAL composer model picker (esbuild, jsx automatic, CSS modules
// as local-css), loads it in headless Chrome, and records the measurements
// plus a screenshot of the open submenu under dist/ultra-effort-menu-logs/.
// Not part of the aggregate gate: it needs a real browser.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logs = join(desktopRoot, 'dist', 'ultra-effort-menu-logs')
mkdirSync(logs, { recursive: true })

await build({
  entryPoints: [join(desktopRoot, 'tests/ultra-effort-menu-dom-entry.tsx')],
  outfile: join(logs, 'bundle.js'),
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.svg': 'text' },
  logLevel: 'warning',
})

const html = join(logs, 'index.html')
writeFileSync(html, '<!doctype html><html><head><meta charset="utf8">'
  + '<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="bundle.css">'
  + '</head><body style="background:#fff;padding:24px;max-width:760px">'
  + '<div id="root"></div><script src="bundle.js"></script></body></html>')
spawnSync('cp', [join(desktopRoot, 'frontend/css/styles.css'), join(logs, 'styles.css')])

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const dump = spawnSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--virtual-time-budget=10000', '--window-size=900,1000',
  '--dump-dom', `file://${html}`,
], { encoding: 'utf8', timeout: 90_000 })
if (dump.status !== 0) { console.error(dump.stderr); process.exit(1) }
writeFileSync(join(logs, 'dom.html'), dump.stdout)

const match = /<pre id="measure-result">([\s\S]*?)<\/pre>/.exec(dump.stdout)
if (!match) { console.error('measure-result missing from dump'); process.exit(1) }
const unescape = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const results = JSON.parse(unescape(match[1]))
writeFileSync(join(logs, 'measure.json'), JSON.stringify(results, null, 2))

const shot = spawnSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--virtual-time-budget=10000', '--window-size=900,1000',
  `--screenshot=${join(logs, 'submenu-ultra.png')}`, `file://${html}?shot`,
], { encoding: 'utf8', timeout: 90_000 })
if (shot.status !== 0) { console.error(shot.stderr); process.exit(1) }

const failed = results.filter(row => row.ok === false)
for (const row of results) console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.name}${row.detail ? ` — ${row.detail}` : ''}`)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
