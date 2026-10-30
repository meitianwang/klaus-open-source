import { strict as assert } from 'node:assert'
import { copyFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'

const executable = require('electron') as string
const { spawnElectronGui } = require(join(__dirname, '../../scripts/electron-test-preflight.cjs')) as typeof import('../scripts/electron-test-preflight.cjs')
const desktopRoot = resolve(__dirname, '../..')

test('screenshot delivery, scoped native image actions and the complete viewer operate in real Electron', async () => {
  const assets = await mkdtemp(join(tmpdir(), 'klaus-image-dom-'))
  const profile = await mkdtemp(join(tmpdir(), 'klaus-image-profile-'))
  const evidence = process.env.KLAUS_IMAGE_EVIDENCE_DIR || join(desktopRoot, 'dist/ui-screenshot-delivery-logs/electron')
  await mkdir(evidence, { recursive: true })
  try {
    await build({ entryPoints: [join(desktopRoot, 'frontend/src/chat/ui-screenshot-dom-entry.ts')],
      outfile: join(assets, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      loader: { '.module.css': 'local-css', '.svg': 'text' }, logLevel: 'silent' })
    await copyFile(join(desktopRoot, 'frontend/css/styles.css'), join(assets, 'styles.css'))
    const html = join(assets, 'index.html')
    await writeFile(html, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="bundle.css"><style>body{margin:0;padding:24px;height:100vh;box-sizing:border-box;overflow:hidden}#messages{max-width:760px;height:calc(100% - 80px);overflow:auto;margin:auto}#composer{display:block;margin:16px auto;width:700px}#artifacts-panel[hidden]{display:none}#artifacts-panel{position:absolute;inset:20px;display:flex;flex-direction:column}#workspace-main-view{height:100%}.workspace-file-body{flex:1;min-height:0}</style></head><body><div id="messages"></div><textarea id="composer" aria-label="Composer"></textarea><div id="artifacts-panel" class="artifacts-panel" data-mode="workspace" hidden><div id="artifact-list"></div><div id="workspace-main-view"><div id="workspace-file-empty" class="workspace-file-empty"></div><div id="workspace-file-shell" class="workspace-file-shell" hidden><div id="workspace-file-tabs" class="workspace-file-tabs" role="tablist"></div><div class="workspace-file-header"><div id="workspace-file-title"></div><div id="workspace-file-path"></div><span id="workspace-file-status" hidden></span><div id="workspace-file-view-toggle" hidden></div><div id="workspace-file-zoom-controls" hidden></div><button id="workspace-file-copy">Copy</button><button id="workspace-file-reveal">Reveal</button></div><div id="workspace-file-truncated" hidden></div><div id="workspace-file-body" class="workspace-file-body"></div></div></div></div><script src="bundle.js"></script></body></html>')
    await writeFile(join(assets, 'preload.cjs'), 'const {contextBridge,ipcRenderer}=require("electron");const first=process.env.KLAUS_IMAGE_FIRST,second=process.env.KLAUS_IMAGE_SECOND;const url=(path,sessionId)=>"klaus-media://localhost/"+Buffer.from(path).toString("base64").replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")+"?s="+encodeURIComponent(sessionId);contextBridge.exposeInMainWorld("screenshotFixture",{first,second,remote:process.env.KLAUS_IMAGE_REMOTE,attach:args=>ipcRenderer.invoke("image-test:attach",args)});contextBridge.exposeInMainWorld("klaus",{media:{url,readImage:args=>ipcRenderer.invoke("image-test:read",args),saveImage:args=>ipcRenderer.invoke("image-test:save",args),copyImage:args=>ipcRenderer.invoke("image-test:copy",args),revealImage:args=>ipcRenderer.invoke("image-test:reveal",args)},clipboard:{writeText:text=>ipcRenderer.invoke("image-test:clipboard",text)},artifacts:{fileUrl:(owner,path)=>ipcRenderer.invoke("image-test:file-url",{owner,path}),read:(owner,path)=>ipcRenderer.invoke("image-test:read-artifact",{owner,path})}});')
    const env: NodeJS.ProcessEnv = { ...process.env, KLAUS_IMAGE_HTML: html, KLAUS_IMAGE_PROFILE: profile, KLAUS_IMAGE_EVIDENCE_DIR: evidence }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawnElectronGui(executable, [join(__dirname, 'ui-screenshot-delivery-fixture.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
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
    const marker = stdout.split('\n').find(line => line.startsWith('SCREENSHOT_DELIVERY_RESULT='))
    assert(marker, stderr + stdout)
    const checks = JSON.parse(marker.slice('SCREENSHOT_DELIVERY_RESULT='.length)) as Record<string, boolean>
    assert(Object.keys(checks).length >= 20, JSON.stringify(checks))
    assert(Object.values(checks).every(Boolean), JSON.stringify(checks))
  } finally { await rm(assets, { recursive: true, force: true }); await rm(profile, { recursive: true, force: true }) }
})
