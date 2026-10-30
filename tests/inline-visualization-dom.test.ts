import { strict as assert } from 'node:assert'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'
const { assertElectronGuiAvailable, spawnElectronGui } = require('../../scripts/electron-test-preflight.cjs') as typeof import('../scripts/electron-test-preflight.cjs');

const executable = require('electron') as string
const desktopRoot = resolve(__dirname, '../..')

test('final assistant pages mount from projected content on a committed eligible DOM node', async () => {
  assertElectronGuiAvailable();
  const assets = await mkdtemp(join(tmpdir(), 'klaus-inline-dom-'))
  const profile = await mkdtemp(join(tmpdir(), 'klaus-inline-profile-'))
  try {
    await build({
      entryPoints: [join(desktopRoot, 'frontend/src/chat/transcript/inline-visualization-dom-entry.ts')],
      outfile: join(assets, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      loader: { '.module.css': 'local-css', '.svg': 'text' }, logLevel: 'silent',
    })
    await copyFile(join(desktopRoot, 'frontend/css/styles.css'), join(assets, 'styles.css'))
    const html = join(assets, 'index.html')
    await writeFile(html, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="bundle.css"></head><body><div id="root"></div><pre id="result"></pre><script src="bundle.js"></script></body></html>')
    const env: NodeJS.ProcessEnv = { ...process.env, KLAUS_INLINE_VIS_HTML: html, KLAUS_INLINE_VIS_PROFILE: profile }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawnElectronGui(executable, [join(__dirname, 'inline-visualization-dom-fixture.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += String(bytes) })
    child.stderr.on('data', bytes => { stderr += String(bytes) })
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
      child.once('error', fail)
      child.once('close', (code, signal) => done({ code, signal }))
    })
    clearTimeout(timer)
    assert.equal(signal, null, stderr)
    assert.equal(code, 0, stderr)
    const marker = stdout.split('\n').find(line => line.startsWith('INLINE_VIS_RESULT='))
    assert(marker, `Missing DOM result: ${stdout}\n${stderr}`)
    process.stdout.write(`${marker}\n`)
    const checks = JSON.parse(marker.slice('INLINE_VIS_RESULT='.length)) as { checks: Record<string, boolean>; openedExternal: string }
    assert.equal(Object.keys(checks.checks).length, 12)
    assert(Object.values(checks.checks).every(Boolean), JSON.stringify(checks))
  } finally {
    await rm(assets, { recursive: true, force: true })
    await rm(profile, { recursive: true, force: true })
  }
})
