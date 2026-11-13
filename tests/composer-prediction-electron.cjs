const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.KLAUS_PREDICTION_TEST_ROOT;
app.setPath('userData', path.join(root, 'profile'));
let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 900, height: 500, show: true, title: 'Message prediction fixture',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data):/.test(details.url) }));
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message) });
  await win.loadFile(path.join(root, 'fixture/index.html'));
  const reply = await win.webContents.executeJavaScript('predictionFixture.run()', true);
  assert.equal(reply.count, 17); assert.equal(reply.draft, '');
  fs.writeFileSync(path.join(root, 'editor-results.json'), JSON.stringify(reply, null, 2));
  fs.writeFileSync(path.join(root, 'editor.png'), (await win.webContents.capturePage()).toPNG());
  for (const result of reply.results) console.log(`PASS ${result}`);
  console.log(`composer-prediction-editor: ${reply.count} passed, 0 failed`);
  win.destroy(); app.quit();
}).catch(error => { console.error(error.stack); win?.destroy(); app.exit(1) });
