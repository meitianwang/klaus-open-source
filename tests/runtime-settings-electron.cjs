const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync, rmSync, appendFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const logs = process.argv[2]
const profile = mkdtempSync(join(tmpdir(), 'klaus-runtime-settings-'))
app.setPath('userData', profile)
const progress = message => appendFileSync(join(logs, 'ui-progress.log'), `${new Date().toISOString()} ${message}\n`)
const timeout = setTimeout(() => { console.error('Runtime settings fixture timed out'); app.exit(1) }, 165_000)

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1000, height: 850, useContentSize: true, show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  window.webContents.on('console-message', (_event, ...args) => console.log('[renderer]', ...args))
  window.webContents.on('render-process-gone', (_event, details) => { console.error('Renderer terminated', details); app.exit(1) })
  let nativeBusy = false
  let timer
  try {
    progress('Loading production settings and permission components')
    await window.loadFile(join(logs, 'index.html'))
    timer = setInterval(async () => {
      if (nativeBusy || window.isDestroyed()) return
      nativeBusy = true
      try {
        const request = await window.webContents.executeJavaScript('window.runtimeNativeRequest')
        if (!request) return
        await window.webContents.executeJavaScript('window.runtimeNativeRequest = undefined')
        window.showInactive()
        window.webContents.focus()
        if (request.width) {
          window.setContentSize(request.width, request.height || 850)
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        if (request.click) {
          const { x, y } = request.click
          window.webContents.sendInputEvent({ type: 'mouseMove', x, y })
          window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
          window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        }
        if (request.key) {
          const modifiers = request.shift ? ['shift'] : []
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode: request.key, modifiers })
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode: request.key, modifiers })
        }
        if (request.capture) {
          await new Promise(resolve => setTimeout(resolve, 50))
          writeFileSync(join(logs, `${request.capture}.png`), (await window.webContents.capturePage()).toPNG())
          progress(`Captured ${request.capture}`)
        }
        await window.webContents.executeJavaScript('window.runtimeNativeDone()')
      } catch (error) {
        await window.webContents.executeJavaScript(`window.runtimeNativeFail(${JSON.stringify(String(error))})`).catch(() => {})
      } finally { nativeBusy = false }
    }, 20)
    await window.webContents.executeJavaScript('window.runtimeSettingsReady')
    const report = await window.webContents.executeJavaScript('({results:window.runtimeSettingsResults,error:window.runtimeSettingsError})')
    writeFileSync(join(logs, 'ui-results.json'), JSON.stringify(report, null, 2))
    if (report.error || !report.results?.passed) throw Error(report.error || 'No runtime settings results')
    console.log('Runtime settings integration:', JSON.stringify(report.results))
    progress(`Passed ${report.results.passed} assertions`)
    clearInterval(timer)
    clearTimeout(timeout)
    window.destroy()
    app.exit(0)
  } catch (error) {
    if (timer) clearInterval(timer)
    console.error(error?.stack ?? error)
    const details = await window.webContents.executeJavaScript('JSON.stringify({active:document.activeElement?.outerHTML?.slice(0,500),error:window.runtimeSettingsError,results:window.runtimeSettingsResults,body:document.body.innerText.slice(-8000)})').catch(() => 'unavailable')
    writeFileSync(join(logs, 'ui-failure.json'), String(details))
    const screenshot = await window.webContents.capturePage().catch(() => undefined)
    if (screenshot) writeFileSync(join(logs, 'ui-failure.png'), screenshot.toPNG())
    progress(`Failed: ${error?.stack ?? error}`)
    app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch {} })
