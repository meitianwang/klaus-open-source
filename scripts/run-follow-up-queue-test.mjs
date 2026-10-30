import { build } from 'esbuild'
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logs = join(desktop, 'dist/follow-up-queue-logs')
const buildOnly = process.argv.includes('--build-only')
mkdirSync(logs, { recursive: true })
const gate = join(logs, 'gate.log')
appendFileSync(gate, `\n$ node apps/desktop/scripts/run-follow-up-queue-test.mjs${buildOnly ? ' --build-only' : ''}\n`)
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
    entryPoints: [join(desktop, 'tests/follow-up-queue-dom-entry.tsx')],
    outfile: join(logs, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome140',
    jsx: 'automatic', loader: { '.module.css': 'local-css', '.svg': 'text', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'warning',
  })
  copyFileSync(join(desktop, 'frontend/css/styles.css'), join(logs, 'styles.css'))
  writeFileSync(join(logs, 'index.html'), `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';font-src 'self';img-src 'self' data: blob:;connect-src 'none'">
<link rel="stylesheet" href="styles.css">
<style>html,body{margin:0;min-width:0;width:100%;height:100%;background:var(--bg);color:var(--text);font-family:var(--font-ui)}#fixture-shell{display:flex;flex-direction:column;justify-content:flex-end;height:100vh;min-width:0;padding:32px 44px;box-sizing:border-box}#fixture-outside{align-self:flex-start;margin-bottom:auto;border:0;background:transparent;color:var(--fg-muted);padding:8px;font:inherit}#input-wrapper{width:100%;max-width:none;margin:0;padding:0;box-sizing:border-box}#input-area{min-height:140px;box-sizing:border-box}#input{min-height:64px}#fixture-composer-footer{display:flex;justify-content:space-between;padding-top:16px;color:var(--fg-muted);font-size:13px}@media(max-width:800px){#fixture-shell{padding:24px 20px}}@media(max-width:440px){#fixture-shell{padding:20px 12px}}</style>
</head><body><main id="fixture-shell"><button id="fixture-outside" type="button">Conversation</button><div id="input-wrapper"><div id="composer-status-stack" class="composer-status-stack"><div id="follow-up-queue" class="follow-up-queue" hidden></div></div><div id="input-area"><div id="slash-input-line"><div id="input" contenteditable="true" role="textbox" aria-label="Message" aria-multiline="true" data-placeholder="Send a message..."></div></div><div id="fixture-composer-footer"><span>Workspace</span><span>Send</span></div></div></div></main><script src="fixture.js"></script></body></html>`)
  appendFileSync(gate, 'Fixture bundle built from current sources.\n')
  if (buildOnly) {
    appendFileSync(gate, 'Follow-up queue fixture build passed\nExit: 0\n')
    console.log('Follow-up queue fixture build passed')
  } else execute([join(desktop, 'scripts/run-electron-test.mjs'), join(desktop, 'tests/follow-up-queue-electron.cjs'), logs], 150_000)
} catch (error) {
  appendFileSync(gate, `${error?.stack ?? error}\n`)
  console.error(error)
  process.exitCode = 1
}
