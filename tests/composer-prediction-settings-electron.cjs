const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { appendFileSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const logs = process.argv[2]
const profile = mkdtempSync(join(tmpdir(), 'klaus-prediction-settings-'))
app.setPath('userData', profile)
const progress = value => appendFileSync(join(logs, 'progress.log'), `${new Date().toISOString()} ${value}\n`)
const timeout = setTimeout(() => { console.error('Prediction settings fixture timed out'); app.exit(1) }, 60_000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1280, height: 1000, useContentSize: true, show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  window.webContents.on('render-process-gone', (_event, details) => { console.error('Renderer terminated', details); app.exit(1) })
  let timer
  try {
    progress('Loading production preferences fixture')
    await window.loadFile(join(logs, 'index.html'))
    let handling = false
    timer = setInterval(async () => {
      if (handling || window.isDestroyed()) return
      handling = true
      try {
        const request = await window.webContents.executeJavaScript('window.predictionSettingsNativeRequest')
        if (!request) return
        await window.webContents.executeJavaScript('window.predictionSettingsNativeRequest = undefined')
        window.showInactive()
        window.webContents.focus()
        if (request.key) {
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode: request.key })
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode: request.key })
        }
        if (request.capture) {
          await new Promise(resolve => setTimeout(resolve, 80))
          writeFileSync(join(logs, `${request.capture}.png`), (await window.webContents.capturePage()).toPNG())
          progress(`Captured ${request.capture}`)
        }
        await window.webContents.executeJavaScript('window.predictionSettingsNativeDone()')
      } catch (error) {
        await window.webContents.executeJavaScript(`window.predictionSettingsNativeFail(${JSON.stringify(String(error))})`).catch(() => {})
      } finally { handling = false }
    }, 20)
    await window.webContents.executeJavaScript('window.predictionSettingsReady')
    const report = await window.webContents.executeJavaScript('({results:window.predictionSettingsResults,error:window.predictionSettingsError})')
    writeFileSync(join(logs, 'results.json'), JSON.stringify(report, null, 2))
    if (report.error || !report.results?.passed) throw Error(report.error || 'No prediction settings results')
    console.log(`Prediction settings integration: ${report.results.passed} checks passed`)
    progress(`Passed ${report.results.passed} checks`)
    clearInterval(timer)
    clearTimeout(timeout)
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error?.stack || error)
    const report = await window.webContents.executeJavaScript('({error:window.predictionSettingsError,body:document.body.innerText})').catch(() => ({ error: 'Renderer unavailable' }))
    writeFileSync(join(logs, 'failure.json'), JSON.stringify(report, null, 2))
    const screenshot = await window.webContents.capturePage().catch(() => undefined)
    if (screenshot) writeFileSync(join(logs, 'failure.png'), screenshot.toPNG())
    progress(`Failed: ${error?.stack || error}`)
    clearInterval(timer)
    clearTimeout(timeout)
    app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch {} })
