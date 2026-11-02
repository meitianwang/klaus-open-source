const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const vectors = require('../contracts/vectors/composer-context-menu-vectors.json')
const output = resolve(process.argv[2] || 'dist/context-menu-logs')
const profile = mkdtempSync(join(tmpdir(), 'klaus-context-picker-'))
app.setPath('userData', profile)
mkdirSync(output, { recursive: true })
buildSync({ entryPoints: [join(__dirname, 'fixtures/composer-context-renderer.tsx')], bundle: true, outfile: join(output, 'context-fixture.js'),
  format: 'iife', platform: 'browser', target: 'chrome132', jsx: 'automatic', logLevel: 'warning',
  loader: { '.svg': 'text', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } })
writeFileSync(join(output, 'context-fixture.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="context-fixture.css"><style>
body{padding:24px;overflow:auto;background:var(--bg);color:var(--fg);font:14px/20px system-ui}main{width:min(900px,100%);margin:auto}h1{font-size:18px}.surface{margin-top:330px}.card{border:1px solid var(--border);border-radius:20px;padding:16px;background:var(--bg-elevated)}[contenteditable]{min-height:48px;white-space:pre-wrap;outline:0;font:14px/20px system-ui}.card>button{padding:4px 10px;border-radius:8px}#side-surface{margin-top:36px;width:min(480px,100%)}
</style><script defer src="context-fixture.js"></script></head><body></body></html>`)
let window
const measurements = []
const pause = () => new Promise(done => setTimeout(done, 25))
const read = expression => window.webContents.executeJavaScript(expression)
async function until(expression) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) { if (await read(expression)) return; await pause() }
  throw new Error(`Timed out waiting for ${expression}`)
}
async function key(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await pause()
}
async function click(selector) {
  const point = await read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 })
  await pause()
}
const snapshot = (owner = 'main') => read(`window.contextFixture.${owner}.snapshot()`)
const text = (value, owner = 'main') => read(`window.contextFixture.${owner}.setText(${JSON.stringify(value)})`)
async function run() {
  await app.whenReady()
  window = new BrowserWindow({ width: 1140, height: 1000, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await window.loadFile(join(output, 'context-fixture.html'))
  await until('window.contextFixture?.ready')
  window.focus(); window.webContents.focus()
  for (const size of [1000, 10000]) {
    await text('')
    await read(`window.contextFixture.setConversationCount(${size});window.contextPerfObserver?.disconnect();window.contextPerf={longTasks:[]};window.contextPerfObserver=new PerformanceObserver(list=>window.contextPerf.longTasks.push(...list.getEntries().map(e=>e.duration)));window.contextPerfObserver.observe({type:'longtask',buffered:false});window.contextPerf.openAt=performance.now();document.getElementById('main-plus').click()`)
    await until('window.contextFixture.main.snapshot().headings.includes("Skills")')
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const opening = await read('({ms:performance.now()-window.contextPerf.openAt,count:document.querySelectorAll("[data-context-key^=perf-chat-]").length,total:document.querySelectorAll("[role=option]").length})')
    assert.equal(opening.count, 0)
    let stats = await read('window.contextFixture.catalogStats')
    assert.equal(stats.fullListReads, 0); assert.equal(stats.searches.length, vectors.conversationSearch.emptyQueryRequests)
    assert.equal(stats.fileOpens, 0); assert.equal(stats.fileSearches, 0)
    assert.equal(await read('!!document.querySelector("[data-context-search-hint]")'), true)
    console.log(`PASS empty picker with ${size} conversations performs no catalog or file reads and renders no conversations`)
    for (const chunk of ['Catalog ', 'conversation']) { await window.webContents.insertText(chunk); await pause() }
    await until(`document.querySelectorAll('[data-context-key^="perf-chat-"]').length===${vectors.queryLimit}`)
    stats = await read('window.contextFixture.catalogStats')
    assert.deepEqual(stats.searches, [{ query: 'Catalog conversation', limit: vectors.conversationSearch.candidateLimit }])
    assert.equal(stats.returned, vectors.conversationSearch.candidateLimit)
    const navigation = []
    for (let index = 0; index < 3; index++) {
      await read('window.contextPerf.keyAt=performance.now()')
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
      navigation.push(await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-window.contextPerf.keyAt))))'))
    }
    await read('document.getElementById("main-context-menu").dispatchEvent(new Event("scroll"))')
    assert.equal((await read('window.contextFixture.catalogStats')).searches.length, 1)
    const result = { size, opening, navigation, searchRows: (await snapshot()).rows.length,
      ...await read('({calls:window.contextFixture.catalogStats.searches.length,longTasks:window.contextPerf.longTasks})') }
    measurements.push(result)
    writeFileSync(join(output, 'catalog-performance.json'), JSON.stringify(measurements, null, 2))
    console.log(JSON.stringify(result))
    await window.webContents.insertText(` ${String(size - 1).padStart(5, '0')}`)
    await until(`document.querySelector('[data-context-key="perf-chat-${size - 1}"]')`)
    assert.equal((await snapshot()).rows.length, 1)
    await key('Enter')
    const selected = await snapshot()
    assert.equal(selected.references[0].kind, 'conversation'); assert.equal(selected.references[0].id, `perf-chat-${size - 1}`)
    assert.equal(selected.submits, 0)
    console.log(`PASS debounced bounded search finds and inserts a conversation at the end of a ${size}-row catalog`)
  }
}

run().then(() => { window?.destroy(); app.quit() }).catch(error => { console.error(error); window?.destroy(); process.exitCode = 1; app.exit(1) })
app.on('quit', () => { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) })
