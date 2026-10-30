import { app, BrowserWindow, protocol } from 'electron'

protocol.registerSchemesAsPrivileged([{ scheme: 'klaus-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])
app.setPath('userData', process.env.KLAUS_INLINE_VIS_PROFILE!)

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  protocol.handle('klaus-media', () => new Response('<!doctype html><body>chart</body>', {
    headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; sandbox allow-scripts" },
  }))
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
  try {
    await window.loadFile(process.env.KLAUS_INLINE_VIS_HTML!)
    let result = ''
    for (let i = 0; i < 120; i++) {
      result = await window.webContents.executeJavaScript("document.getElementById('result')?.textContent || ''") as string
      if (result.startsWith('{')) break
      await wait(20)
    }
    process.stdout.write(`INLINE_VIS_RESULT=${result}\n`)
    const output = JSON.parse(result) as { checks?: Record<string, boolean> }
    if (!output.checks || Object.keys(output.checks).length === 0 || Object.values(output.checks).some(value => value !== true)) process.exitCode = 1
  } finally { window.destroy(); protocol.unhandle('klaus-media') }
}
app.whenReady().then(main).catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1 }).finally(() => app.quit())
