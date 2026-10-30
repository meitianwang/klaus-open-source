import { app, BrowserWindow, protocol } from 'electron'
import { realpath, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { WidgetService } from '../main/services/widgets'
import { MediaFiles } from '../main/services/media-files'

protocol.registerSchemesAsPrivileged([{ scheme: 'klaus-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])
const profile = process.env.KLAUS_WIDGET_DOM_PROFILE!
const assets = process.env.KLAUS_WIDGET_DOM_ASSETS!
app.setPath('userData', profile)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const sessionId = 'session-12345678'
  const service = new WidgetService(profile, () => assets)
  const code = '<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.sendToAgent({count:1},{submit:false});setTimeout(()=>window.sendToAgent({count:2},{submit:true}),150)</script></body></html>'
  const result = await service.run({ title: 'Counter', widget_code: code }, sessionId, 'widget-dom-call')
  const snapshot = JSON.parse(String((result as { contentItems: Array<{ text: string }> }).contentItems[0]?.text)) as { widgetId: string; revision: number; path: string }
  const checked = await service.snapshotPath(sessionId, snapshot.widgetId, snapshot.revision, snapshot.path)
  const media = new MediaFiles(async (path, id) => {
    try { return path.startsWith(await realpath(join(profile, 'widgets', id)) + sep) } catch { return false }
  })
  const url = await media.grantWidgetSnapshot(checked.path, sessionId, checked.root)
  protocol.handle('klaus-media', request => media.respond(request))
  const html = join(assets, 'index.html')
  await writeFile(html, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"></head><body><div id="root"></div><pre id="result"></pre><script>window.fixtureWidget=${JSON.stringify({ snapshot, url })}</script><script src="bundle.js"></script></body></html>`)
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
  try {
    await window.loadFile(html)
    let output = ''
    for (let i = 0; i < 150; i++) {
      output = await window.webContents.executeJavaScript("document.getElementById('result')?.textContent || ''") as string
      if (output.startsWith('{')) break
      await wait(20)
    }
    process.stdout.write(`WIDGET_DOM_RESULT=${output}\n`)
    const checks = JSON.parse(output) as Record<string, boolean>
    if (Object.keys(checks).length !== 7 || Object.values(checks).some(value => value !== true)) process.exitCode = 1
  } finally { window.destroy(); media.close(); protocol.unhandle('klaus-media') }
}
app.whenReady().then(main).catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1 }).finally(() => app.quit())
