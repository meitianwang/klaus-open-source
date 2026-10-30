import { app, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

app.setPath('userData', process.env.KLAUS_VISUAL_CARD_PROFILE!)

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const window = new BrowserWindow({
    show: false, width: 1200, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  try {
    await window.loadFile(process.env.KLAUS_VISUAL_CARD_HTML!)
    let result = ''
    for (let i = 0; i < 200; i++) {
      result = await window.webContents.executeJavaScript("document.getElementById('result')?.textContent || ''") as string
      if (result.startsWith('{')) break
      await wait(20)
    }
    // Keep one capture of the final mounted state as durable evidence: the raw
    // measurements below are text, and a reviewer should be able to see the card.
    const evidence = process.env.KLAUS_VISUAL_CARD_EVIDENCE_DIR
    if (evidence) {
      // capturePage reads the compositor, so an off-screen window that never
      // painted yields blank bytes even while every check below passes. Show it,
      // force a layout+paint round trip, and give it two frames before reading.
      window.showInactive()
      await window.webContents.executeJavaScript('document.body.offsetHeight; void 0')
      await wait(300)
      const image = await window.webContents.capturePage()
      await writeFile(join(evidence, 'final-state.png'), image.toPNG()).catch(() => {})
    }
    process.stdout.write(`VISUAL_CARD_RESULT=${result}\n`)
    const checks = JSON.parse(result) as Record<string, boolean | string>
    const booleans = Object.entries(checks).filter(([, value]) => typeof value === 'boolean')
    if (checks.error || booleans.length < 10 || booleans.some(([, value]) => value !== true)) process.exitCode = 1
  } finally { window.destroy() }
}

app.whenReady().then(main).catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1 }).finally(() => app.quit())
