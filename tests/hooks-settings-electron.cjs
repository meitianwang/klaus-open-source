const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync, rmSync, appendFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const logs = process.argv[2]
const profile = mkdtempSync(join(tmpdir(), 'klaus-hooks-settings-'))
app.setPath('userData', profile)
const progress = message => appendFileSync(join(logs, 'progress.log'), `${new Date().toISOString()} ${message}\n`)
const timeout = setTimeout(() => { console.error('Hooks settings fixture timed out'); app.exit(1) }, 120_000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1512, height: 949, useContentSize: true, show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  window.webContents.on('console-message', (_event, ...args) => console.log('[renderer]', ...args))
  window.webContents.on('render-process-gone', (_event, details) => { console.error('Renderer terminated', details); app.exit(1) })
  try {
    progress('Loading fixture')
    await window.loadFile(join(logs, 'index.html'))
    let nativeBusy = false
    const timer = setInterval(async () => {
      if (nativeBusy || window.isDestroyed()) return
      nativeBusy = true
      try {
        const request = await window.webContents.executeJavaScript('window.hooksNativeRequest')
        if (!request) return
        await window.webContents.executeJavaScript('window.hooksNativeRequest = undefined')
        window.showInactive()
        window.webContents.focus()
        if (request.width) {
          window.setContentSize(request.width, request.height || 949)
          await new Promise(resolve => setTimeout(resolve, 80))
        }
        if (request.key) {
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode: request.key, modifiers: request.shift ? ['shift'] : [] })
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode: request.key, modifiers: request.shift ? ['shift'] : [] })
        }
        if (request.capture) {
          await new Promise(resolve => setTimeout(resolve, 60))
          writeFileSync(join(logs, `${request.capture}.png`), (await window.webContents.capturePage()).toPNG())
          progress(`Captured ${request.capture}`)
        }
        await window.webContents.executeJavaScript('window.hooksNativeDone()')
      } catch (error) {
        console.error('Native fixture request failed', error)
        await window.webContents.executeJavaScript(`window.hooksNativeFail(${JSON.stringify(String(error))})`).catch(() => {})
      } finally { nativeBusy = false }
    }, 25)
    try { await window.webContents.executeJavaScript('window.hooksSettingsReady') }
    finally { clearInterval(timer) }
    const report = await window.webContents.executeJavaScript('({results:window.hooksSettingsResults,error:window.hooksSettingsError})')
    writeFileSync(join(logs, 'results.json'), JSON.stringify(report, null, 2))
    if (report.error || !report.results?.passed) throw Error(report.error || 'No hooks settings results')
    console.log('Hooks settings integration:', JSON.stringify(report.results))
    progress(`Passed ${report.results.passed} checks`)
    clearTimeout(timeout)
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error?.stack ?? error)
    const details = await window.webContents.executeJavaScript('JSON.stringify({active:document.activeElement?.outerHTML?.slice(0,500),error:window.hooksSettingsError,results:window.hooksSettingsResults,body:document.body.innerText.slice(-8000)})').catch(() => 'unavailable')
    console.error(details)
    writeFileSync(join(logs, 'failure.json'), String(details))
    const screenshot = await window.webContents.capturePage().catch(() => undefined)
    if (screenshot) writeFileSync(join(logs, 'failure.png'), screenshot.toPNG())
    progress(`Failed: ${error?.stack ?? error}`)
    app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch {} })
