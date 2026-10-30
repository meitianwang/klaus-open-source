import { build } from 'esbuild'
import { appendFileSync, closeSync, copyFileSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logArgument = process.argv.find(value => value.startsWith('--logs='))
const logs = logArgument ? resolve(logArgument.slice(7)) : join(desktop, 'dist/windows-sandbox-ui-logs')
mkdirSync(logs, { recursive: true })
const gate = join(logs, 'ui-gate.log')
function execute(args, timeout) {
  appendFileSync(gate, `$ ${[process.execPath, ...args].join(' ')}\n`)
  const output = openSync(gate, 'a')
  let result
  try { result = spawnSync(process.execPath, args, { stdio: ['ignore', output, output], timeout }) }
  finally { closeSync(output) }
  appendFileSync(gate, `Exit: ${result.status}\n`)
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`Command exited ${result.status}`)
}
try {
  execute([join(desktop, 'scripts/electron-test-preflight.cjs')], 40_000)
  await build({ entryPoints: [join(desktop, 'tests/windows-sandbox-ui-entry.tsx')], outfile: join(logs, 'fixture.js'),
    bundle: true, platform: 'browser', format: 'iife', target: 'chrome140', jsx: 'automatic',
    loader: { '.module.css': 'local-css', '.svg': 'text', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'warning' })
  copyFileSync(join(desktop, 'frontend/css/styles.css'), join(logs, 'styles.css'))
  writeFileSync(join(logs, 'index.html'), `<!doctype html><html lang="zh" data-theme="light"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';font-src 'self';img-src 'self' data:;connect-src 'none'">
<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="fixture.css"><style>html,body{margin:0;min-width:0;background:var(--bg);font-family:var(--font)}main{padding:28px;display:grid;gap:40px}.composer{min-width:0;max-width:720px;margin:auto;width:100%}.input{padding:20px;border:1px solid var(--border);border-radius:14px;color:var(--fg-tertiary);font-size:13px}@media(max-width:500px){main{padding:14px;gap:20px}}</style></head>
<body><main><section id="main-composer" class="composer"><div class="input">Main chat</div></section><section id="side-composer" class="composer"><div class="input">Side chat</div></section></main><script src="fixture.js"></script></body></html>`)
  execute([join(desktop, 'scripts/run-electron-test.mjs'), join(desktop, 'tests/windows-sandbox-ui-electron.cjs'), logs], 120_000)
  console.log(`Windows preparation UI passed; original output: ${gate}`)
} catch (error) {
  appendFileSync(gate, `${error?.stack ?? error}\n`)
  console.error(error)
  process.exitCode = 1
}
