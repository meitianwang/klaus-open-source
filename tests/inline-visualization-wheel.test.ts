import { strict as assert } from 'node:assert'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'
const { assertElectronGuiAvailable, spawnElectronGui } = require('../../scripts/electron-test-preflight.cjs') as typeof import('../scripts/electron-test-preflight.cjs')

const executable = require('electron') as string
const desktopRoot = resolve(__dirname, '../..')

test('wheel input over inline pages reaches the transcript without stealing inner scrolling', async () => {
  assertElectronGuiAvailable()
  const vectors = JSON.parse(await readFile(join(desktopRoot, 'contracts/vectors/inline-visualization-scroll-vectors.json'), 'utf8')) as Array<{ check: string; reason: string }>
  const assets = await mkdtemp(join(tmpdir(), 'klaus-inline-wheel-'))
  const profile = await mkdtemp(join(tmpdir(), 'klaus-inline-wheel-profile-'))
  try {
    await build({
      entryPoints: [join(desktopRoot, 'frontend/src/chat/transcript/inline-visualization-wheel-entry.ts')],
      outfile: join(assets, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      loader: { '.module.css': 'local-css', '.svg': 'text' }, logLevel: 'silent',
    })
    await copyFile(join(desktopRoot, 'frontend/css/styles.css'), join(assets, 'styles.css'))
    const html = join(assets, 'index.html')
    await writeFile(html, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"></head><body><script src="bundle.js"></script></body></html>')
    const env: NodeJS.ProcessEnv = { ...process.env, KLAUS_INLINE_VIS_HTML: html, KLAUS_INLINE_VIS_PROFILE: profile }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawnElectronGui(executable, [join(__dirname, 'inline-visualization-wheel-fixture.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += String(bytes) })
    child.stderr.on('data', bytes => { stderr += String(bytes) })
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
      child.once('error', fail)
      child.once('close', (code, signal) => done({ code, signal }))
    })
    clearTimeout(timer)
    const marker = stdout.split('\n').find(line => line.startsWith('INLINE_VIS_WHEEL_RESULT='))
    assert(marker, `Missing wheel result: ${stdout}\n${stderr}`)
    process.stdout.write(`${marker}\n`)
    const result = JSON.parse(marker.slice('INLINE_VIS_WHEEL_RESULT='.length)) as { checks: Record<string, boolean> }
    assert.equal(signal, null, stderr)
    assert.equal(code, 0, JSON.stringify(result))
    assert.deepEqual(Object.keys(result.checks).sort(), vectors.map(vector => vector.check).sort())
    for (const vector of vectors) assert.equal(result.checks[vector.check], true, vector.reason)
  } finally {
    await rm(assets, { recursive: true, force: true })
    await rm(profile, { recursive: true, force: true })
  }
})
