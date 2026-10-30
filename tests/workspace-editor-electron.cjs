const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const logs = process.argv[2]
const profile = mkdtempSync(join(tmpdir(), 'klaus-workspace-editor-'))
app.setPath('userData', profile)
const timeout = setTimeout(() => { console.error('Workspace editor fixture timed out'); app.exit(1) }, 90_000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  window.webContents.on('console-message', (_event, ...args) => console.log('[renderer]', ...args))
  window.webContents.on('render-process-gone', (_event, details) => { console.error('Renderer terminated', details); app.exit(1) })
  try {
    await window.loadFile(join(logs, 'index.html'))
    let nativeBusy = false
    const nativeTimer = setInterval(async () => {
      if (nativeBusy || window.isDestroyed()) return
      nativeBusy = true
      try {
        const request = await window.webContents.executeJavaScript('window.workspaceNativeRequest')
        if (request) {
          await window.webContents.executeJavaScript('window.workspaceNativeRequest = undefined')
          window.showInactive()
          window.webContents.focus()
          if (request.capture) writeFileSync(join(logs, `${request.capture}.png`), (await window.webContents.capturePage()).toPNG())
          if (request.text) await window.webContents.insertText(request.text)
          if (request.undo) {
            window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['meta'] })
            window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['meta'] })
          }
          await window.webContents.executeJavaScript('window.workspaceNativeDone()')
        }
      } finally { nativeBusy = false }
    }, 30)
    try { await window.webContents.executeJavaScript('window.workspaceEditorReady') }
    finally { clearInterval(nativeTimer) }
    const results = await window.webContents.executeJavaScript('({results:window.workspaceEditorResults,error:window.workspaceEditorError})')
    writeFileSync(join(logs, 'results.json'), JSON.stringify(results, null, 2))
    if (results.error || !results.results?.passed) throw Error(results.error || 'No editor results')
    const screenshot = await window.webContents.capturePage()
    writeFileSync(join(logs, 'workspace-editor.png'), screenshot.toPNG())
    console.log('Workspace editor integration:', JSON.stringify(results.results))
    clearTimeout(timeout)
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error?.stack ?? error)
    console.error(await window.webContents.executeJavaScript('JSON.stringify({focused:document.hasFocus(),active:document.activeElement?.outerHTML?.slice(0,500),error:window.workspaceEditorError})').catch(() => 'unavailable'))
    const screenshot = await window.webContents.capturePage().catch(() => undefined)
    if (screenshot) writeFileSync(join(logs, 'failure.png'), screenshot.toPNG())
    app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch {} })
