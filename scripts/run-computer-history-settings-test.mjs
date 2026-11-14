import { build } from 'esbuild'
import { copyFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnElectronGui, assertElectronGuiAvailable } from './electron-test-preflight.cjs'

assertElectronGuiAvailable()
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const output = join(desktop, 'dist/computer-history-redesign-logs')
mkdirSync(output, { recursive: true })
const log = join(output, 'ui-gate.log')
writeFileSync(log, '$ node apps/desktop/scripts/run-computer-history-settings-test.mjs\n')

await build({
  entryPoints: [join(desktop, 'tests/computer-history-settings-dom-entry.tsx')],
  outfile: join(output, 'fixture.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome140',
  jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.svg': 'text', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  logLevel: 'warning',
})

copyFileSync(join(desktop, 'frontend/css/styles.css'), join(output, 'styles.css'))
writeFileSync(
  join(output, 'index.html'),
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="fixture.css"></head><body class="settings-open"><div id="settings-view" class="active"><div class="settings-sidebar"></div><main class="settings-main" data-stab="computerHistory"><div id="settings-content" class="settings-content"><div id="fixture-root"></div></div></main></div><script src="fixture.js"></script></body></html>',
)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawnElectronGui(
  require('electron'),
  [join(desktop, 'tests/computer-history-settings-electron.cjs'), output],
  { cwd: desktop, env, stdio: ['ignore', 'pipe', 'pipe'] },
)
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', data => { appendFileSync(log, data); process.stdout.write(data) })
}
const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
try {
  const code = await new Promise((yes, no) => { child.once('error', no); child.once('close', yes) })
  appendFileSync(log, `Exit: ${code}\n`)
  process.exitCode = code === 0 ? 0 : 1
} finally {
  clearTimeout(timer)
}
