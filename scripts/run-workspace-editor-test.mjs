import { build } from 'esbuild'
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assertElectronGuiAvailable } from './electron-test-preflight.cjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logs = join(desktop, 'dist/workspace-editor-logs')
mkdirSync(logs, { recursive: true })
assertElectronGuiAvailable()
await build({
  entryPoints: [join(desktop, 'tests/workspace-editor-dom-entry.tsx')],
  outfile: join(logs, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome140',
  loader: { '.module.css': 'local-css', '.svg': 'text', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'warning',
})
copyFileSync(join(desktop, 'frontend/css/styles.css'), join(logs, 'styles.css'))
writeFileSync(join(logs, 'index.html'), `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';font-src 'self';img-src 'self' data: blob: klaus-media:;connect-src 'none'">
<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="fixture.css">
<style>body{margin:0;background:var(--bg)}#workspace-main-view{display:flex;height:740px;width:100%;position:relative}#artifacts-panel{display:flex!important;width:100vw!important;max-width:none!important;height:740px;position:relative!important}#artifacts-list{display:none!important}#workspace-main-view{max-width:none!important;flex:1;inset:0}.workspace-file-shell{display:flex;width:100%;flex:1;min-height:0;flex-direction:column}.workspace-file-body{flex:1;min-height:0}</style>
</head><body><div id="artifacts-panel"><div id="artifacts-list"></div><div id="workspace-main-view">
<div id="workspace-file-empty"></div><div id="workspace-file-shell" hidden>
<div id="workspace-file-tabs" class="workspace-file-tabs"></div><div class="workspace-file-header">
<div class="workspace-file-titleblock"><div id="workspace-file-title"></div><div id="workspace-file-path"></div><span id="workspace-file-status" hidden></span></div>
<div id="workspace-file-view-toggle" class="workspace-file-view-toggle" hidden><button id="workspace-file-view-preview" class="workspace-file-view-btn">Preview</button><button id="workspace-file-view-source" class="workspace-file-view-btn">Source</button></div>
<button id="workspace-file-copy">Copy path</button><button id="workspace-file-reveal">Reveal</button></div>
<div id="workspace-file-truncated" hidden></div><div id="workspace-file-body" class="workspace-file-body"></div>
</div></div></div><script src="fixture.js"></script></body></html>`)
const command = [process.execPath, join(desktop, 'scripts/run-electron-test.mjs'), join(desktop, 'tests/workspace-editor-electron.cjs'), logs]
const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', env: process.env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
writeFileSync(join(logs, 'gate.log'), `$ ${command.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}\nExit: ${result.status}\n`)
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
if (result.error) throw result.error
process.exitCode = result.status ?? 1
