import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { spawnElectronGui } from './electron-test-preflight.cjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logs = join(desktop, 'dist/composer-prediction-settings-logs')
const require = createRequire(import.meta.url)
const buildOnly = process.argv.includes('--build-only')
mkdirSync(logs, { recursive: true })
const gate = join(logs, 'gate.log')
writeFileSync(gate, `$ node apps/desktop/scripts/run-composer-prediction-settings-test.mjs${buildOnly ? ' --build-only' : ''}\n`)
try {
  if (!buildOnly) {
    const args = [join(desktop, 'scripts/electron-test-preflight.cjs')]
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 40_000 })
    appendFileSync(gate, `$ ${[process.execPath, ...args].join(' ')}\n${result.stdout || ''}${result.stderr || ''}\nExit: ${result.status}\n`)
    process.stdout.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    if (result.error || result.status !== 0) throw result.error || Error('Electron GUI preflight refused')
  }
  await build({
    entryPoints: [join(desktop, 'tests/composer-prediction-settings-dom-entry.tsx')],
    outfile: join(logs, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome140', jsx: 'automatic',
    loader: { '.module.css': 'local-css', '.svg': 'text', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'warning',
  })
  copyFileSync(join(desktop, 'frontend/css/styles.css'), join(logs, 'styles.css'))
  writeFileSync(join(logs, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';font-src 'self';img-src 'self' data:;connect-src 'none'"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="fixture.css"></head><body><div id="settings-view" class="active"><main class="settings-main"><div id="settings-content" class="settings-content"><div id="fixture-root"></div></div></main></div><script src="fixture.js"></script></body></html>`)
  appendFileSync(gate, 'Fixture built from production preferences, localization and styles.\n')
  if (buildOnly) console.log('Prediction settings fixture build passed')
  else {
    const args = [join(desktop, 'tests/composer-prediction-settings-electron.cjs'), logs]
    appendFileSync(gate, `$ ${[require('electron'), ...args].join(' ')}\n`)
    const child = spawnElectronGui(require('electron'), args, { cwd: desktop, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { appendFileSync(gate, chunk); process.stdout.write(chunk) })
    const timer = setTimeout(() => child.kill('SIGTERM'), 75_000)
    const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('close', resolveCode) })
    clearTimeout(timer)
    appendFileSync(gate, `Exit: ${code}\n`)
    if (code !== 0) throw Error(`Prediction settings fixture exited ${code}`)
  }
  appendFileSync(gate, 'Exit: 0\n')
} catch (error) {
  appendFileSync(gate, `${error?.stack || error}\nExit: 1\n`)
  console.error(error)
  process.exitCode = 1
}
