const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')

const output = process.argv[2]
const profile = mkdtempSync(join(tmpdir(), 'klaus-computer-history-ui-'))
app.setPath('userData', profile)
const timer = setTimeout(() => { console.error('Computer History UI fixture timed out'); app.exit(1) }, 50_000)

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 920,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  })
  try {
    await window.loadFile(join(output, 'index.html'))
    await window.webContents.executeJavaScript('window.computerHistoryReady')
    const result = await window.webContents.executeJavaScript('window.computerHistoryResults')
    await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-stab="computerHistory"]')?.scrollIntoView({ block: 'center' });
      document.querySelectorAll('.toast-root').forEach(el => el.remove());
    })()`)
    await new Promise(r => setTimeout(r, 40))
    writeFileSync(join(output, 'overview.png'), (await window.webContents.capturePage()).toPNG())

    // Capture Add Rule modal (App picker view)
    await window.webContents.executeJavaScript(`document.getElementById('computer-history-add-rule').click(); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
    await new Promise(r => setTimeout(r, 80))
    writeFileSync(join(output, 'add-rule-app.png'), (await window.webContents.capturePage()).toPNG())

    // Switch to Website view inside Add Rule modal and preview subdomain match
    await window.webContents.executeJavaScript(`(() => {
      const btn = Array.from(document.querySelectorAll('dialog [role="radio"]')).find(b => b.textContent === '网站');
      btn.click();
    })()`)
    await new Promise(r => setTimeout(r, 50))
    await window.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('computer-history-url-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://www.github.com/org/repo');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await new Promise(r => setTimeout(r, 50))
    writeFileSync(join(output, 'add-rule-url.png'), (await window.webContents.capturePage()).toPNG())

    // Close Add Rule modal and open Clear History modal
    await window.webContents.executeJavaScript(`document.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true })); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
    await new Promise(r => setTimeout(r, 50))
    await window.webContents.executeJavaScript(`document.getElementById('computer-history-clear-open').click(); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
    await new Promise(r => setTimeout(r, 50))
    writeFileSync(join(output, 'clear-dialog.png'), (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript(`document.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true })); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)

    // Narrow content-pane verification (480px content pane, matching computer-use-settings-test)
    await window.webContents.executeJavaScript(`document.querySelector('.settings-sidebar').style.display = 'none'`)
    window.setContentSize(480, 860)
    await window.webContents.executeJavaScript(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
    const narrow = await window.webContents.executeJavaScript(`(() => {
      const main = document.querySelector('.settings-main');
      const row = document.querySelector('[data-rule-row]');
      const btn = row.querySelector('button');
      return {
        mainClientWidth: main.clientWidth,
        mainScrollWidth: main.scrollWidth,
        btnRight: btn.getBoundingClientRect().right,
        rowRight: row.getBoundingClientRect().right,
      };
    })()`)
    assert(narrow.mainScrollWidth <= narrow.mainClientWidth + 1, `narrow layout must not overflow horizontally (${narrow.mainScrollWidth} vs ${narrow.mainClientWidth})`)
    assert(narrow.btnRight <= narrow.rowRight + 1, 'remove button stays inside rule row')
    result.narrow = narrow
    writeFileSync(join(output, 'results.json'), JSON.stringify(result, null, 2))
    console.log(`Computer history settings UI: ${result.passed} checks passed; narrow layout passed; ${JSON.stringify(result.measurements)}`)
    app.exit(0)
  } catch (error) {
    console.error(error.stack || String(error))
    const state = await window.webContents.executeJavaScript('({ error: window.computerHistoryError, body: document.body.innerText })').catch(() => ({}))
    writeFileSync(join(output, 'failure.json'), JSON.stringify(state, null, 2))
    writeFileSync(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG())
    app.exit(1)
  } finally {
    clearTimeout(timer)
  }
}).catch(error => { console.error(error); app.exit(1) })

process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch {} })
