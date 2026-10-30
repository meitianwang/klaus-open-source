// Manual DOM harness runner for the file-citation and inline-media surfaces.
// Bundles the REAL markdown pipeline, player mount pass and transcript click
// delegate (esbuild, jsx automatic, CSS modules as local-css), loads them in
// headless Chrome, and records the measurements plus a screenshot under
// dist/file-citation-logs/. Not part of the aggregate gate: it needs a real
// browser, and the gate's browser fixtures own their own profiles.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logs = join(desktopRoot, 'dist', 'file-citation-logs')
mkdirSync(logs, { recursive: true })

const alias = {
  'klaus-styles': join(desktopRoot, 'frontend/css/styles.css'),
  'klaus-markdown': join(desktopRoot, 'frontend/src/chat/markdown.ts'),
  'klaus-media-player': join(desktopRoot, 'frontend/src/chat/transcript/media-player.ts'),
  'klaus-transcript': join(desktopRoot, 'frontend/src/chat/transcript/TranscriptView.tsx'),
  'klaus-workspace-panel': join(desktopRoot, 'frontend/src/chat/workspace-panel.ts'),
}

await build({
  entryPoints: [join(desktopRoot, 'tests/file-citation-dom-entry.tsx')],
  outfile: join(logs, 'bundle.js'),
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.svg': 'text' },
  alias, logLevel: 'warning',
})

const html = join(logs, 'index.html')
writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8">'
  + '<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="bundle.css">'
  + '</head><body style="background:#fff;padding:24px;max-width:760px">'
  + '<div id="root"></div><script src="bundle.js"></script></body></html>')
// The page keeps its styles beside it; copy the global sheet once.
spawnSync('cp', [join(desktopRoot, 'frontend/css/styles.css'), join(logs, 'styles.css')])

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const dump = spawnSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required',
  '--virtual-time-budget=6000', '--window-size=900,1200',
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
  '--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=2',
  '--virtual-time-budget=6000', '--window-size=900,1200',
  `--screenshot=${join(logs, 'transcript.png')}`, `file://${html}`,
], { encoding: 'utf8', timeout: 90_000 })
if (shot.status !== 0) { console.error(shot.stderr); process.exit(1) }

const failures = Object.entries(results).filter(([key, value]) => {
  if (key === 'clockText' || key === 'chipLabel' || key === 'chipLineLabel' || key === 'directiveLabel' || key === 'videoUnavailableSubtitle' || key === 'openCalls') return false
  return value !== true
})
console.log(JSON.stringify(results, null, 2))
if (failures.length) { console.error(`FAILURES: ${failures.map(([key]) => key).join(', ')}`); process.exit(1) }
console.log('file-citation DOM harness: all measurements green')

// ---------------------------------------------------------------------------
// Second page: the citation's line jump through the real workspace panel.
// The panel module grabs its DOM at load, so the page carries the panel
// skeleton copied verbatim out of index.html.
// ---------------------------------------------------------------------------
const indexHtml = readFileSync(join(desktopRoot, 'frontend/index.html'), 'utf8').split('\n')
// The real panel sits in a fixed-height flex column; the harness page has no
// app chrome, so the skeleton gets an explicit height for the scroll container
// to have something to scroll against.
const skeleton = indexHtml.slice(682, 725).join('\n')
  .replace('id="workspace-main-view"', 'id="workspace-main-view" style="height:700px"')
await build({
  entryPoints: [join(desktopRoot, 'tests/file-citation-line-dom-entry.tsx')],
  outfile: join(logs, 'line-bundle.js'),
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.svg': 'text' },
  alias, logLevel: 'warning',
})
const lineHtml = join(logs, 'line.html')
writeFileSync(lineHtml, '<!doctype html><html><head><meta charset="utf-8">'
  + '<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="line-bundle.css">'
  + '</head><body style="background:#fff;margin:0">'
  + '<div id="artifacts-panel" class="artifacts-panel" data-mode="workspace" style="display:block;height:800px">'
  + '<div id="artifacts-list"></div>'
  + skeleton
  + '</div><script src="line-bundle.js"></script></body></html>')
const lineDump = spawnSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--virtual-time-budget=6000', '--window-size=900,900',
  '--dump-dom', `file://${lineHtml}`,
], { encoding: 'utf8', timeout: 90_000 })
if (lineDump.status !== 0) { console.error(lineDump.stderr); process.exit(1) }
writeFileSync(join(logs, 'line-dom.html'), lineDump.stdout)
const lineMatch = /<pre id="measure-result">([\s\S]*?)<\/pre>/.exec(lineDump.stdout)
if (!lineMatch) { console.error('line measure-result missing'); process.exit(1) }
const lineResults = JSON.parse(unescape(lineMatch[1]))
writeFileSync(join(logs, 'line-measure.json'), JSON.stringify(lineResults, null, 2))
console.log(JSON.stringify(lineResults, null, 2))
if (lineResults.scrolled !== true || !(lineResults.renderedLines > 0)) { console.error('line jump FAILED'); process.exit(1) }
console.log('file-citation line-jump harness: green')
