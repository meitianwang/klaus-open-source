import { build } from 'esbuild'
import { appendFileSync, closeSync, copyFileSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logs = join(desktop, 'dist/runtime-settings-logs')
const buildOnly = process.argv.includes('--build-only')
mkdirSync(logs, { recursive: true })
const gate = join(logs, 'ui-gate.log')
appendFileSync(gate, `\n$ node apps/desktop/scripts/run-runtime-settings-test.mjs${buildOnly ? ' --build-only' : ''}\n`)
function execute(args, timeout) {
  appendFileSync(gate, `$ ${[process.execPath, ...args].join(' ')}\n`)
  const output = openSync(gate, 'a')
  let result
  try { result = spawnSync(process.execPath, args, { stdio: ['ignore', output, output], timeout }) }
  finally { closeSync(output) }
  appendFileSync(gate, `\nExit: ${result.status}\n`)
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`Command exited ${result.status}`)
  console.log(`Command passed; original output: ${gate}`)
}

try {
  if (!buildOnly) execute([join(desktop, 'scripts/electron-test-preflight.cjs')], 40_000)
  await build({
    entryPoints: [join(desktop, 'tests/runtime-settings-dom-entry.tsx')], outfile: join(logs, 'fixture.js'),
    bundle: true, platform: 'browser', format: 'iife', target: 'chrome140', jsx: 'automatic',
    loader: { '.module.css': 'local-css', '.svg': 'text', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'warning',
  })
  copyFileSync(join(desktop, 'frontend/css/styles.css'), join(logs, 'styles.css'))
  writeFileSync(join(logs, 'index.html'), `<!doctype html><html lang="zh" data-theme="light"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';font-src 'self';img-src 'self' data: blob:;connect-src 'none'">
<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="fixture.css">
<style>html,body{margin:0;width:100%;height:100%;min-width:0;background:var(--bg);font-family:var(--font)}body{display:flex;flex-direction:column}#fixture-root{flex:1;overflow:auto;padding:32px;box-sizing:border-box}#composer-fixture{height:180px;flex-shrink:0;padding:24px 32px;border-top:1px solid var(--border);display:flex;align-items:flex-end;gap:48px;box-sizing:border-box}.fixture-composer{min-width:0;display:grid;gap:8px}.fixture-composer-label{color:var(--fg-tertiary);font-size:12px}button{cursor:default}@media(max-width:600px){#fixture-root{padding:20px 12px}#composer-fixture{padding:16px 12px;gap:16px}}</style>
</head><body><main id="fixture-root"></main><div id="composer-fixture"><div class="fixture-composer"><span class="fixture-composer-label">Main chat</span><div class="kls-select kls-select--flat" id="permission-select"></div></div><div class="fixture-composer"><span class="fixture-composer-label">Side chat</span><div class="kls-select kls-select--flat" id="side-permission-select"></div></div></div><script src="fixture.js"></script></body></html>`)
  appendFileSync(gate, 'Fixture built from production components.\n')
  if (!buildOnly) execute([join(desktop, 'scripts/run-electron-test.mjs'), join(desktop, 'tests/runtime-settings-electron.cjs'), logs], 180_000)
  else console.log('Runtime settings fixture build passed')
} catch (error) {
  appendFileSync(gate, `${error?.stack ?? error}\n`)
  console.error(error)
  process.exitCode = 1
}
