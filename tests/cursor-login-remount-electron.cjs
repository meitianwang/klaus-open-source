const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const desktop = resolve(__dirname, '..');
const logs = process.env.KLAUS_CURSOR_TEST_LOG_DIR || join(desktop, 'dist/cursor-login-remount-logs');
const profile = process.env.KLAUS_CURSOR_TEST_PROFILE;
if (!profile) { console.error('Use scripts/test-cursor-login-remount.mjs'); app.exit(1); }
app.setPath('userData', profile);
mkdirSync(logs, { recursive: true });
let window;
app.whenReady().then(async () => {
  buildSync({ entryPoints: [join(__dirname, 'cursor-login-remount-entry.tsx')], bundle: true,
    outfile: join(logs, 'entry.js'), format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.svg': 'text' },
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
  writeFileSync(join(logs, 'index.html'), '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; script-src &apos;self&apos;; style-src &apos;self&apos; &apos;unsafe-inline&apos;"></head><body><div id="root"></div><script src="./entry.js"></script></body></html>');
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', event => console.log('renderer:', event.message));
  await window.loadFile(join(logs, 'index.html'));
  const deadline = Date.now() + 20_000;
  let result;
  while (!result && Date.now() < deadline) {
    result = await window.webContents.executeJavaScript('window.cursorRemountResult');
    if (!result) await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!result) throw new Error('Account remount fixture timed out');
  writeFileSync(join(logs, 'dom.html'), await window.webContents.executeJavaScript('document.documentElement.outerHTML'));
  writeFileSync(join(logs, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  return result.failed ? 1 : 0;
}).catch(error => { console.error(error); return 1; }).then(code => {
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(code);
});
