const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const output = process.argv[2]
const profile = mkdtempSync(join(tmpdir(), 'klaus-settings-navigation-'))
app.setPath('userData', profile)
const timer = setTimeout(() => { console.error('Settings navigation fixture timed out'); app.exit(1) }, 60000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  try {
    await window.loadFile(join(output, 'index.html'))
    await window.webContents.executeJavaScript('window.settingsNavigationReady')
    const result = await window.webContents.executeJavaScript('window.settingsNavigationResults')
    writeFileSync(join(output, 'results.json'), JSON.stringify(result, null, 2))
    if (result.capture) writeFileSync(join(output, 'success.png'), (await window.webContents.capturePage()).toPNG())
    console.log(`Settings navigation: ${result.passed} checks passed; ${result.pages.length} pages; ${result.frameCount} frames; ${result.missingFrames.length} missing-content frames`)
    app.exit(0)
  } catch (error) {
    console.error(error?.stack || String(error))
    const report = await window.webContents.executeJavaScript('({ error: window.settingsNavigationError, body: document.body.innerText })')
    writeFileSync(join(output, 'failure.json'), JSON.stringify(report, null, 2))
    writeFileSync(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG())
    app.exit(1)
  } finally { clearTimeout(timer) }
}).catch(error => { console.error(error); app.exit(1) })
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch {} })
