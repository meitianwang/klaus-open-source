import { build } from 'esbuild'
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { spawnElectronGui } from './electron-test-preflight.cjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const voiceSource = process.argv.includes('--voice-source')
const musicSource = process.argv.includes('--music-source')
const storageSettings = process.argv.includes('--storage')
const fixtureName = storageSettings ? 'storage-settings' : musicSource ? 'music-source-settings' : voiceSource ? 'voice-source-settings' : 'settings-navigation'
const logs = join(desktop, `dist/${fixtureName}-logs`)
const require = createRequire(import.meta.url)
mkdirSync(logs, { recursive: true })
const log = join(logs, 'gate.log')
writeFileSync(log, `$ node apps/desktop/scripts/run-settings-navigation-test.mjs${storageSettings ? ' --storage' : musicSource ? ' --music-source' : voiceSource ? ' --voice-source' : ''}\n`)
try {
  const args = [join(desktop, 'scripts/electron-test-preflight.cjs')]
  const preflight = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 40000 })
  appendFileSync(log, `$ node ${args.join(' ')}\n${preflight.stdout || ''}${preflight.stderr || ''}\nExit: ${preflight.status}\n`)
  if (preflight.error || preflight.status !== 0) throw preflight.error || Error('Electron GUI preflight refused')
  await build({ entryPoints: [join(desktop, `tests/${fixtureName}-dom-entry.tsx`)], outfile: join(logs, 'fixture.js'), bundle: true,
    platform: 'browser', format: 'iife', target: 'chrome140', jsx: 'automatic', loader: { '.module.css': 'local-css', '.svg': 'text', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, logLevel: 'warning' })
  copyFileSync(join(desktop, 'frontend/css/styles.css'), join(logs, 'styles.css'))
  writeFileSync(join(logs, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="fixture.css"></head><body><div id="settings-view" class="active"><main class="settings-main"><div id="settings-content" class="settings-content"><div id="fixture-root"></div></div></main></div><script src="fixture.js"></script></body></html>')
  const command = [join(desktop, storageSettings ? 'tests/storage-settings-electron.cjs' : 'tests/settings-navigation-electron.cjs'), logs]
  appendFileSync(log, `$ ${require('electron')} ${command.join(' ')}\n`)
  const child = spawnElectronGui(require('electron'), command, { cwd: desktop, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { appendFileSync(log, data); process.stdout.write(data) })
  const timer = setTimeout(() => child.kill('SIGTERM'), 75000)
  const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('close', resolveCode) })
  clearTimeout(timer)
  appendFileSync(log, `Exit: ${code}\n`)
  if (code !== 0) throw Error(`Settings navigation fixture exited ${code}`)
} catch (error) {
  appendFileSync(log, `${error?.stack || error}\nExit: 1\n`)
  console.error(error)
  process.exitCode = 1
}
