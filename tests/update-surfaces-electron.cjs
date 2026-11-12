const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync, rmSync, appendFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const logs = process.argv[2]
const profile = mkdtempSync(join(tmpdir(), 'klaus-update-surfaces-'))
app.setPath('userData', profile)
const progress = message => appendFileSync(join(logs, 'progress.log'), `${new Date().toISOString()} ${message}\n`)
const timeout = setTimeout(() => { console.error('Update surfaces fixture timed out'); app.exit(1) }, 120_000)

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  window.webContents.on('console-message', (_event, ...args) => console.log('[renderer]', ...args))
  window.webContents.on('render-process-gone', (_event, details) => { console.error('Renderer terminated', details); app.exit(1) })
  try {
    progress('Loading fixture')
    await window.loadFile(join(logs, 'index.html'))
    // The fixture drives real timers (the detail's delay gate), so readiness is
    // polled rather than read once: an early read would see no results at all.
    const deadline = Date.now() + 60_000
    for (;;) {
      const ready = await window.webContents.executeJavaScript('!!window.updateSurfacesResults')
      if (ready) break
      if (Date.now() > deadline) throw Error('Update surfaces fixture never reported results')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const report = await window.webContents.executeJavaScript('({results:window.updateSurfacesResults,error:window.updateSurfacesError})')
    writeFileSync(join(logs, 'results.json'), JSON.stringify(report, null, 2))

    // Capture the surfaces a person actually sees, from the real components.
    const capture = async (name, setup) => {
      await window.webContents.executeJavaScript(setup)
      await new Promise(resolve => setTimeout(resolve, 260))
      window.showInactive()
      writeFileSync(join(logs, `${name}.png`), (await window.webContents.capturePage()).toPNG())
      progress(`Captured ${name}`)
    }
    await capture('downloading-detail', 'window.updateSurfacesFixture.downloading()')
    await capture('downloading-collapsed', 'window.updateSurfacesFixture.collapse()')
    await capture('ready-decision', 'window.updateSurfacesFixture.ready()')
    await capture('installing-overlay', 'window.updateSurfacesFixture.installing()')
    await capture('settings-page', 'window.updateSurfacesFixture.settings()')

    if (report.error || report.results?.failed) throw Error(report.error || `${report.results?.failed} update surface checks failed`)
    console.log('Update surfaces integration:', JSON.stringify({ passed: report.results.passed, failed: report.results.failed }))
    progress(`Passed ${report.results.passed} checks`)
    clearTimeout(timeout)
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error?.stack ?? error)
    const details = await window.webContents.executeJavaScript('JSON.stringify({error:window.updateSurfacesError,results:window.updateSurfacesResults,body:document.body.innerText.slice(-6000)})').catch(() => 'unavailable')
    console.error(details)
    clearTimeout(timeout)
    app.exit(1)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})