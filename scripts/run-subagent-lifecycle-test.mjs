import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnElectronGui } from './electron-test-preflight.cjs'

const desktop = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(desktop, 'package.json'))
const output = join(desktop, 'dist', 'subagent-lifecycle-logs')
const fixture = join(output, 'fixture')
mkdirSync(fixture, { recursive: true })
await require('esbuild').build({ entryPoints: [join(desktop, 'frontend/src/chat/subagent-lifecycle-dom-entry.ts')],
  outfile: join(fixture, 'browser.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.svg': 'text' }, logLevel: 'silent' })
cpSync(join(desktop, 'frontend/css'), join(fixture, 'css'), { recursive: true })
cpSync(join(desktop, 'frontend/public/agent-avatar.png'), join(fixture, 'agent-avatar.png'))
writeFileSync(join(fixture, 'index.html'), `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<link rel="stylesheet" href="css/styles.css"><link rel="stylesheet" href="browser.css">
<style>html,body{width:100%;height:100%;margin:0;background:var(--bg);color:var(--fg)}
#messages,#subagent-messages{padding:48px 64px;height:100%;overflow-y:auto;display:flex;flex-direction:column;gap:16px}
[hidden]{display:none!important}#back{position:fixed;top:8px;left:12px;z-index:2}</style></head>
<body><button id="back" hidden>Back to parent</button><div id="messages"></div><div id="subagent-messages" hidden></div><script src="browser.js"></script></body></html>`)
const binary = require('electron')
const args = [join(desktop, 'tests/subagent-lifecycle-electron.cjs')]
const env = { ...process.env, KLAUS_LIFECYCLE_TEST_ROOT: output }
delete env.ELECTRON_RUN_AS_NODE
const chunks = ['COMMAND: ' + JSON.stringify([binary, ...args]) + '\n']
const child = spawnElectronGui(binary, args, { cwd: desktop, env, stdio: ['ignore', 'pipe', 'pipe'] })
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { chunks.push(String(chunk)); process.stdout.write(chunk) })
const timer = setTimeout(() => child.kill('SIGTERM'), 60000)
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
clearTimeout(timer)
chunks.push('\nEXIT: ' + code + '\n')
writeFileSync(join(output, 'electron.log'), chunks.join(''))
process.exitCode = code === 0 ? 0 : 1
