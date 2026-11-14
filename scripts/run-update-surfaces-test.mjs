import { build } from 'esbuild'
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { spawnElectronGui } from './electron-test-preflight.cjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logs = join(desktop, 'dist/update-surfaces-logs')
const require = createRequire(import.meta.url)
mkdirSync(logs, { recursive: true })
const gate = join(logs, 'gate.log')
writeFileSync(gate, '$ node apps/desktop/scripts/run-update-surfaces-test.mjs\n')

try {
  const preflight = spawnSync(process.execPath, [join(desktop, 'scripts/electron-test-preflight.cjs')], { encoding: 'utf8', timeout: 40_000 })
  appendFileSync(gate, `$ node scripts/electron-test-preflight.cjs\n${preflight.stdout ?? ''}${preflight.stderr ?? ''}\nExit: ${preflight.status}\n`)
  if (preflight.error || preflight.status !== 0) throw preflight.error || Error('Electron GUI preflight refused')

  await build({
    entryPoints: [join(desktop, 'tests/update-surfaces-dom-entry.tsx')],
    outfile: join(logs, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome140',
    jsx: 'automatic', loader: { '.module.css': 'local-css', '.svg': 'text', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'warning',
  })
  copyFileSync(join(desktop, 'frontend/css/styles.css'), join(logs, 'styles.css'))
  writeFileSync(join(logs, 'index.html'), `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';font-src 'self';img-src 'self' data: blob:;connect-src 'none'">
<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="fixture.css">
<style>
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:var(--font)}
#shell{display:flex;height:100vh;min-width:0}
#sidebar{width:280px;flex:none;display:flex;flex-direction:column;background:var(--bg-secondary);border-right:1px solid var(--border)}
#sidebar-scroll{flex:1;min-height:0}
.sidebar-footer{padding:8px 12px;border-top:1px solid var(--border-subtle);font-size:13px;color:var(--fg-secondary)}
#settings-root{flex:1;min-width:0;overflow:auto;padding:40px 32px;box-sizing:border-box}
#settings-root>section{max-width:720px;margin:auto}
</style></head><body><div id="shell">
<aside id="sidebar"><div id="sidebar-scroll"></div><div id="sidebar-update-card"></div><div class="sidebar-footer">Account</div></aside>
<main id="settings-root"></main></div><script src="fixture.js"></script></body></html>`)

  const command = [join(desktop, 'tests/update-surfaces-electron.cjs'), logs]
  appendFileSync(gate, `$ ${require('electron')} ${command.join(' ')}\n`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawnElectronGui(require('electron'), command, { cwd: desktop, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { appendFileSync(gate, data); process.stdout.write(data) })
  const timer = setTimeout(() => child.kill('SIGTERM'), 150_000)
  const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('close', resolveCode) })
  clearTimeout(timer)
  appendFileSync(gate, `Exit: ${code}\n`)
  if (code !== 0) throw Error(`Update surfaces fixture exited ${code}`)
} catch (error) {
  appendFileSync(gate, `${error?.stack ?? error}\nExit: 1\n`)
  console.error(error)
  process.exitCode = 1
}