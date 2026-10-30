const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { appendFileSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const logs = process.argv[2], profile = mkdtempSync(join(tmpdir(), 'klaus-profile-page-'))
app.setPath('userData', profile)
app.commandLine.appendSwitch('force-color-profile', 'srgb')
const deadline = setTimeout(() => { console.error('Profile page fixture timed out'); app.exit(1) }, 120_000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1512, height: 865, useContentSize: true, show: false, titleBarStyle: 'hidden', webPreferences: { sandbox: true, contextIsolation: true } })
  window.webContents.on('console-message', (_event, ...args) => console.log('[renderer]', ...args))
  let polling = false
  const timer = setInterval(async () => {
    if (polling || window.isDestroyed()) return
    polling = true
    try {
      const request = await window.webContents.executeJavaScript('window.profileNativeRequest')
      if (!request) return
      await window.webContents.executeJavaScript('window.profileNativeRequest = undefined')
      if (request.width) { window.setContentSize(request.width, request.height || 865); await new Promise(resolve => setTimeout(resolve, 80)) }
      if (request.key) { window.showInactive(); window.webContents.focus(); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: request.key, modifiers: request.shift ? ['shift'] : [] }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: request.key, modifiers: request.shift ? ['shift'] : [] }) }
      if (request.capture) {
        await window.webContents.executeJavaScript('Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))')
        writeFileSync(join(logs, request.capture + '.png'), (await window.webContents.capturePage()).toPNG())
      }
      await window.webContents.executeJavaScript('window.profileNativeDone()')
    } catch (error) { console.error(error); await window.webContents.executeJavaScript(`window.profileNativeFail(${JSON.stringify(String(error))})`).catch(() => {}) }
    finally { polling = false }
  }, 25)
  try {
    await window.loadFile(join(logs, 'index.html'))
    await window.webContents.executeJavaScript('window.profileReady')
    const result = await window.webContents.executeJavaScript('window.profileResults')
    writeFileSync(join(logs, 'gui-results.json'), JSON.stringify(result, null, 2))
    if (result.error || !result.passed) throw Error(result.error || 'No profile results')
    console.log('Profile page integration:', JSON.stringify(result))
    appendFileSync(join(logs, 'gui-progress.log'), `Passed ${result.passed} checks\n`)
    clearInterval(timer); clearTimeout(deadline); window.destroy(); app.exit(0)
  } catch (error) {
    console.error(error?.stack ?? error)
    writeFileSync(join(logs, 'failure.json'), await window.webContents.executeJavaScript('JSON.stringify({results:window.profileResults,body:document.body.innerText})').catch(() => 'unavailable'))
    const screenshot = await window.webContents.capturePage().catch(() => undefined)
    if (screenshot) writeFileSync(join(logs, 'failure.png'), screenshot.toPNG())
    clearInterval(timer); app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch {} })
