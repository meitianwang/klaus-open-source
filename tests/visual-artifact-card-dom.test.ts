import { strict as assert } from 'node:assert'
import { copyFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'

const executable = require('electron') as string
const { spawnElectronGui } = require(join(__dirname, '../../scripts/electron-test-preflight.cjs')) as typeof import('../scripts/electron-test-preflight.cjs')
const desktopRoot = resolve(__dirname, '../..')

test('a 3D scene and a diagram each render a clickable card that opens its own panel, in real Electron', async () => {
  const assets = await mkdtemp(join(tmpdir(), 'klaus-visual-card-dom-'))
  const profile = await mkdtemp(join(tmpdir(), 'klaus-visual-card-profile-'))
  const evidence = process.env.KLAUS_VISUAL_CARD_EVIDENCE_DIR || join(desktopRoot, 'dist/visual-artifact-card-logs/electron')
  await mkdir(evidence, { recursive: true })
  try {
    await build({
      entryPoints: [join(desktopRoot, 'frontend/src/chat/transcript/visual-artifact-card-dom-entry.ts')],
      outfile: join(assets, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      loader: { '.module.css': 'local-css', '.svg': 'text' }, logLevel: 'silent',
    })
    await copyFile(join(desktopRoot, 'frontend/css/styles.css'), join(assets, 'styles.css'))
    const html = join(assets, 'index.html')
    await writeFile(html, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="bundle.css"><style>body{margin:0;padding:24px}#messages{max-width:760px;margin:auto}</style></head><body><div id="messages"></div><pre id="result"></pre><script src="bundle.js"></script></body></html>')
    const env: NodeJS.ProcessEnv = { ...process.env, KLAUS_VISUAL_CARD_HTML: html, KLAUS_VISUAL_CARD_PROFILE: profile, KLAUS_VISUAL_CARD_EVIDENCE_DIR: evidence }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawnElectronGui(executable, [join(__dirname, 'visual-artifact-card-dom-fixture.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += String(bytes) })
    child.stderr.on('data', bytes => { stderr += String(bytes) })
    const timer = setTimeout(() => child.kill('SIGTERM'), 90_000)
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
      child.once('error', fail); child.once('close', (code, signal) => done({ code, signal }))
    })
    clearTimeout(timer)
    process.stdout.write(stdout)
    assert.equal(result.signal, null, stderr)
    assert.equal(result.code, 0, stderr + stdout)
    const marker = stdout.split('\n').find(line => line.startsWith('VISUAL_CARD_RESULT='))
    assert(marker, `Missing DOM result: ${stderr}${stdout}`)
    const checks = JSON.parse(marker.slice('VISUAL_CARD_RESULT='.length)) as Record<string, boolean | string>
    assert.equal(checks.error, undefined, JSON.stringify(checks))
    const booleans = Object.entries(checks).filter(([, value]) => typeof value === 'boolean')
    assert(booleans.length >= 10, JSON.stringify(checks))
    assert(booleans.every(([, value]) => value === true), JSON.stringify(checks))
  } finally {
    await rm(assets, { recursive: true, force: true })
    await rm(profile, { recursive: true, force: true })
  }
})
