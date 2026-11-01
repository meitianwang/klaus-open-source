import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { assertElectronGuiAvailable, spawnElectronGui } from './electron-test-preflight.cjs'

const desktop = dirname(dirname(fileURLToPath(import.meta.url)))
const work = join(desktop, 'dist/subagent-avatar-generation')
const output = join(desktop, 'frontend/public/subagent-avatars')
mkdirSync(work, { recursive: true })
mkdirSync(output, { recursive: true })

const entry = join(work, 'generate-entry.ts')
writeFileSync(entry, `
import { createOrbGpuRenderer } from ${JSON.stringify(join(desktop, 'scripts/subagent-avatar-orb/renderer.ts'))}

async function generate() {
  const renderer = await createOrbGpuRenderer()
  if (!renderer) throw new Error('WebGPU is required to generate static avatar assets')
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 96
  const images: string[] = []
  for (let avatarId = 0; avatarId < 28; avatarId += 1) {
    renderer.render(avatarId, (avatarId % 997) * 0.037, canvas)
    images.push(canvas.toDataURL('image/webp', 0.9))
  }
  renderer.destroy()
  ;(window as any).generatedOrbs = images
}
generate().catch(error => { (window as any).generationError = String(error?.stack || error) })
`)

await build({
  entryPoints: [entry],
  bundle: true,
  outfile: join(work, 'generate.js'),
  format: 'iife',
  platform: 'browser',
  target: 'safari17',
  loader: { '.wgsl': 'text' },
  logLevel: 'warning',
})
writeFileSync(join(work, 'page.html'), '<!doctype html><html><body><script src="./generate.js"></script></body></html>')

const electronEntry = join(work, 'electron-generate.cjs')
writeFileSync(electronEntry, `
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const path = require('node:path')
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } })
  try {
    await window.loadFile(path.join(__dirname, 'page.html'))
    let images = null
    let error = ''
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      images = await window.webContents.executeJavaScript('window.generatedOrbs || null')
      error = await window.webContents.executeJavaScript('window.generationError || ""')
      if (images || error) break
    }
    if (!images) throw new Error(error || 'Generation did not finish')
    images.forEach((dataUrl, index) => {
      writeFileSync(path.join(${JSON.stringify(output)}, 'orb-' + index + '.webp'), Buffer.from(dataUrl.split(',')[1], 'base64'))
    })
    console.log('Generated ' + images.length + ' static orb avatars')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
`)

assertElectronGuiAvailable()
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawnElectronGui(createRequire(import.meta.url)('electron'), [electronEntry], { env, stdio: 'inherit' })
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', code => resolve(code ?? 1))
})
if (exitCode !== 0) throw new Error(`Avatar generation exited with ${exitCode}`)
