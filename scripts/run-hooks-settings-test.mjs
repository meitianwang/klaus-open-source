import { build } from 'esbuild'
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logs = join(desktop, 'dist/hooks-settings-logs')
const buildOnly = process.argv.includes('--build-only')
mkdirSync(logs, { recursive: true })
const gate = join(logs, 'gate.log')
appendFileSync(gate, `\n$ node apps/desktop/scripts/run-hooks-settings-test.mjs${buildOnly ? ' --build-only' : ''}\n`)
const execute = (args, timeout = 120_000) => {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env, timeout, maxBuffer: 16 * 1024 * 1024 })
  appendFileSync(gate, `$ ${[process.execPath, ...args].join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}\nExit: ${result.status}\n`)
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`Command exited ${result.status}: ${args.join(' ')}`)
}

try {
  if (!buildOnly) execute([join(desktop, 'scripts/electron-test-preflight.cjs')], 40_000)
  await build({
    entryPoints: [join(desktop, 'tests/hooks-settings-dom-entry.tsx')],
    outfile: join(logs, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome140',
    jsx: 'automatic', loader: { '.module.css': 'local-css', '.svg': 'text', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'warning',
  })
  copyFileSync(join(desktop, 'frontend/css/styles.css'), join(logs, 'styles.css'))
  writeFileSync(join(logs, 'index.html'), `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';font-src 'self';img-src 'self' data: blob:;connect-src 'none'">
<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="fixture.css">
<style>html,body{margin:0;min-width:0;width:100%;height:100%;background:var(--bg);color:var(--text);font-family:var(--font-ui)}#fixture-shell{display:flex;height:100vh;min-width:0}.fixture-sidebar{width:280px;flex-shrink:0;background:var(--bg-secondary);padding:44px 20px;box-sizing:border-box}.fixture-sidebar h2{font-size:16px;margin:0 0 32px}.fixture-sidebar p{font-size:13px;color:var(--text-muted);margin:20px 0 8px}.fixture-sidebar div{padding:8px 12px;font-size:14px}.fixture-sidebar .active{background:var(--hover-bg);border-radius:9px}#settings-content{flex:1;min-width:0;overflow:auto;padding:64px 32px;box-sizing:border-box}#fixture-root{max-width:760px;margin:auto}@media(max-width:800px){.fixture-sidebar{width:170px;padding:32px 12px}#settings-content{padding:32px 20px}}</style>
</head><body><div id="fixture-shell"><aside class="fixture-sidebar"><h2>Klaus</h2><p>General</p><div>Preferences</div><div>Keyboard shortcuts</div><p>Engine</p><div>Models</div><div>Network</div><div>Permission rules</div><div>Sandbox</div><div class="active">Hooks</div><div>Memory</div></aside><main id="settings-content"><div id="fixture-root"></div></main></div><script src="fixture.js"></script></body></html>`)
  appendFileSync(gate, 'Fixture bundle built from current sources.\n')
  if (buildOnly) {
    appendFileSync(gate, 'Hooks settings fixture build passed\nExit: 0\n')
    console.log('Hooks settings fixture build passed')
  }
  else execute([join(desktop, 'scripts/run-electron-test.mjs'), join(desktop, 'tests/hooks-settings-electron.cjs'), logs], 150_000)
} catch (error) {
  appendFileSync(gate, `${error?.stack ?? error}\n`)
  console.error(error)
  process.exitCode = 1
}
