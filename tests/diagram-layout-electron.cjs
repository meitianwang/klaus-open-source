const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const profile = mkdtempSync(join(tmpdir(), 'klaus-diagram-layout-'))
app.setPath('userData', profile)
const timeout = setTimeout(() => { console.error('Diagram layout fixture timed out'); app.exit(1) }, 90_000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  const errors = []
  window.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message)
  })
  try {
    await window.loadURL(process.argv[2])
    const result = await window.webContents.executeJavaScript('window.diagramLayoutReady')
    if (errors.length) throw new Error(errors.join('\n'))
    console.log(JSON.stringify(result, null, 2))
    clearTimeout(timeout)
    window.destroy()
    app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch {} })
