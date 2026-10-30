const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync, rmSync, appendFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const logs = process.argv[2]
if (!logs) throw Error('A fixture log directory is required')
const profile = mkdtempSync(join(tmpdir(), 'klaus-follow-up-queue-'))
app.setPath('userData', profile)
const progress = message => appendFileSync(join(logs, 'progress.log'), `${new Date().toISOString()} ${message}\n`)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const timeout = setTimeout(() => { console.error('Follow-up queue fixture timed out'); app.exit(1) }, 120_000)
app.whenReady().then(async () => {
  // Keep physical pointer movement from racing the fixture's trusted Chromium input.
  const window = new BrowserWindow({ width: 1512, height: 560, useContentSize: true, show: false, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } })
  window.webContents.on('console-message', (_event, ...args) => console.log('[renderer]', ...args))
  window.webContents.on('render-process-gone', (_event, details) => { console.error('Renderer terminated', details); app.exit(1) })
  try {
    progress('Loading fixture')
    await window.loadFile(join(logs, 'index.html'))
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await window.webContents.executeJavaScript(`(() => {
      window.queueNativeEvidence = []
      for (const name of ['pointerenter', 'pointerleave', 'pointermove', 'pointerdown', 'pointerup']) {
        document.addEventListener(name, event => window.queueNativeEvidence.push({ name, trusted: event.isTrusted,
          x: event.clientX, y: event.clientY, at: performance.now(), target: event.target.outerHTML?.slice(0, 240) }), true)
      }
    })()`)
    const focusWindow = async () => {
      const deadline = Date.now() + 5000
      do {
        window.webContents.focus()
        if (await window.webContents.executeJavaScript('document.hasFocus()')) return
        await delay(30)
      } while (Date.now() < deadline)
      throw Error('Native input window and document did not acquire focus')
    }
    let nativeBusy = false
    const timer = setInterval(async () => {
      if (nativeBusy || window.isDestroyed()) return
      nativeBusy = true
      try {
        const request = await window.webContents.executeJavaScript('window.queueNativeRequest')
        if (!request) return
        await window.webContents.executeJavaScript('window.queueNativeRequest = undefined')
        await focusWindow()
        if (request.width) {
          window.setContentSize(request.width, request.height || 560)
          await delay(80)
        }
        if (request.key) {
          const modifiers = request.shift ? ['shift'] : []
          const keyCode = ({ ArrowDown: 'Down', ArrowUp: 'Up', ArrowLeft: 'Left', ArrowRight: 'Right' })[request.key] || request.key
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
        }
        for (const pointer of request.pointer || []) {
          window.webContents.sendInputEvent(pointer)
          await delay(35)
        }
        if (request.capture) {
          await delay(60)
          const crop = request.cropQueue ? await window.webContents.executeJavaScript(`(() => {
            const rect = document.querySelector('#composer-status-stack').getBoundingClientRect()
            return { x: 0, y: Math.max(0, Math.round(rect.top - 24)), width: innerWidth, height: 75 }
          })()`) : undefined
          writeFileSync(join(logs, `${request.capture}.png`), (await window.webContents.capturePage(crop)).toPNG())
          progress(`Captured ${request.capture}`)
        }
        await window.webContents.executeJavaScript('window.queueNativeDone()')
      } catch (error) {
        console.error('Native fixture request failed', error)
        await window.webContents.executeJavaScript(`window.queueNativeFail(${JSON.stringify(String(error))})`).catch(() => {})
      } finally { nativeBusy = false }
    }, 25)
    try { await window.webContents.executeJavaScript('window.followUpQueueReady') }
    finally { clearInterval(timer) }
    const report = await window.webContents.executeJavaScript('({results:window.followUpQueueResults,error:window.followUpQueueError})')
    writeFileSync(join(logs, 'results.json'), JSON.stringify(report, null, 2))
    writeFileSync(join(logs, 'native-input.json'), JSON.stringify(await window.webContents.executeJavaScript('window.queueNativeEvidence'), null, 2))
    if (report.error || !report.results?.passed) throw Error(report.error || 'No follow-up queue results')
    console.log('Follow-up queue integration:', JSON.stringify(report.results))
    progress(`Passed ${report.results.passed} checks`)
    clearTimeout(timeout)
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error?.stack ?? error)
    const details = await window.webContents.executeJavaScript('JSON.stringify({active:document.activeElement?.outerHTML?.slice(0,500),error:window.followUpQueueError,results:window.followUpQueueResults,body:document.body.innerText.slice(-8000)})').catch(() => 'unavailable')
    console.error(details)
    writeFileSync(join(logs, 'failure.json'), String(details))
    writeFileSync(join(logs, 'native-input.json'), JSON.stringify(await window.webContents.executeJavaScript('window.queueNativeEvidence').catch(() => []), null, 2))
    const screenshot = await window.webContents.capturePage().catch(() => undefined)
    if (screenshot) writeFileSync(join(logs, 'failure.png'), screenshot.toPNG())
    progress(`Failed: ${error?.stack ?? error}`)
    app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch {} })
