import { build, loadConfigFromFile } from 'vite'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { assertElectronGuiAvailable } from './electron-test-preflight.cjs'
import { frontendDiagramWorker } from './frontend-diagram-worker.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logs = join(desktop, 'dist/diagram-layout-logs')
const output = join(logs, 'build')
mkdirSync(logs, { recursive: true })
assertElectronGuiAvailable()
const configFlag = process.argv.indexOf('--config')
const configFile = configFlag < 0 ? join(desktop, 'vite.config.mts') : resolve(process.argv[configFlag + 1])
const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, configFile)
if (!loaded) throw new Error('The desktop build config could not be loaded')
const result = await build({
  ...loaded.config,
  configFile: false, root: join(desktop, 'tests'), plugins: [frontendDiagramWorker(), ...(loaded.config.plugins ?? [])],
  build: { ...loaded.config.build, outDir: output, emptyOutDir: true, rollupOptions: { ...loaded.config.build?.rollupOptions, input: join(desktop, 'tests/diagram-layout.html') } },
})
const files = result.output
const worker = files.find(file => file.type === 'asset' && /elk-worker\.min-.*\.js$/.test(file.fileName))
const rendererChunks = files.filter(file => file.type === 'chunk')
if (!worker) throw new Error('The layout worker asset is missing')
const require = createRequire(import.meta.url)
if (!readFileSync(join(output, worker.fileName)).equals(readFileSync(require.resolve('elkjs/lib/elk-worker.min.js')))) throw new Error('The emitted layout engine differs from the complete installed engine')
if (rendererChunks.some(chunk => Buffer.byteLength(chunk.code) > 500_000)) throw new Error('The layout API exceeded the renderer chunk budget')
writeFileSync(join(logs, 'assets.json'), JSON.stringify({ worker: { fileName: worker.fileName, bytes: statSync(join(output, worker.fileName)).size }, rendererChunks: rendererChunks.map(chunk => ({ fileName: chunk.fileName, bytes: Buffer.byteLength(chunk.code) })) }, null, 2))
const server = createServer((request, response) => {
  const path = resolve(output, '.' + new URL(request.url ?? '/', 'http://localhost').pathname)
  if (relative(output, path).startsWith('..') || !existsSync(path) || !statSync(path).isFile()) { response.writeHead(404).end(); return }
  response.setHeader('Content-Type', extname(path) === '.js' ? 'application/javascript' : 'text/html')
  createReadStream(path).pipe(response)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const address = server.address()
  const command = [join(desktop, 'scripts/run-electron-test.mjs'), join(desktop, 'tests/diagram-layout-electron.cjs'), `http://127.0.0.1:${address.port}/diagram-layout.html`]
  const child = spawn(process.execPath, command, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data; process.stdout.write(data) })
  child.stderr.on('data', data => { stderr += data; process.stderr.write(data) })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  writeFileSync(join(logs, 'gate.log'), `$ ${[process.execPath, ...command].join(' ')}\n${stdout}${stderr}\nExit: ${code}\n`)
  if (code !== 0) throw new Error('The browser worker integration fixture failed')
} finally { await new Promise(resolve => server.close(resolve)) }
