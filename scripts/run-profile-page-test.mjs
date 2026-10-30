import { build } from 'esbuild'
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logs = resolve(process.argv[2] || join(desktop, 'dist/profile-page-logs'))
mkdirSync(logs, { recursive: true })
const gate = join(logs, 'gui-gate.log')
const execute = args => {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 150_000, maxBuffer: 16 * 1024 * 1024 })
  appendFileSync(gate, `$ ${[process.execPath, ...args].join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}\nExit: ${result.status}\n`)
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '')
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`Command exited ${result.status}`)
}
try {
  execute([join(desktop, 'scripts/electron-test-preflight.cjs')])
  await build({ entryPoints: [join(desktop, 'tests/profile-page-dom-entry.tsx')], outfile: join(logs, 'fixture.js'), bundle: true,
    platform: 'browser', format: 'iife', target: 'chrome140', jsx: 'automatic',
    loader: { '.module.css': 'local-css', '.svg': 'text', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'warning' })
  copyFileSync(join(desktop, 'frontend/css/styles.css'), join(logs, 'styles.css'))
  writeFileSync(join(logs, 'index.html'), `<!doctype html><html lang="zh" data-theme="light"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';font-src 'self';img-src 'self' data: blob:;connect-src 'none'">
<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="fixture.css">
<style>html,body{margin:0;width:100%;height:100%;min-width:0;background:#f0f1f2;color:var(--fg);font-family:var(--font)}#fixture-frame{position:absolute;inset:44px 6px 4px 52px;border-radius:12px;overflow:hidden}#profile-view{display:block}#profile-view-content{min-height:100%}[data-theme=dark] body{background:#202123}</style>
</head><body><div id="fixture-frame"><div id="profile-view" class="active"><div id="profile-view-content"></div></div></div><div id="settings-view"><div class="settings-sidebar"></div><div class="settings-main"><div class="settings-content" id="settings-content"></div></div></div><script src="fixture.js"></script></body></html>`)
  execute([join(desktop, 'scripts/run-electron-test.mjs'), join(desktop, 'tests/profile-page-electron.cjs'), logs])
} catch (error) { appendFileSync(gate, `${error?.stack ?? error}\n`); console.error(error); process.exitCode = 1 }
