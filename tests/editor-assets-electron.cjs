const { app, BrowserWindow, net, protocol } = require('electron');
const { writeFileSync } = require('node:fs');
const { join, relative, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');

const [root, logs, profile] = process.argv.slice(2);
if (!root || !logs || !profile) throw new Error('Use scripts/run-editor-assets-test.mjs');
const scheme = 'klaus-editor-assets';
protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setPath('userData', profile);
const timeout = setTimeout(() => { console.error('Editor dependency assets fixture timed out'); app.exit(1); }, 110_000);

app.whenReady().then(async () => {
  protocol.handle(scheme, request => {
    const path = resolve(root, '.' + decodeURIComponent(new URL(request.url).pathname));
    const local = relative(root, path);
    if (local === '..' || local.startsWith('..' + sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path).href);
  });
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true } });
  const rendererErrors = [];
  window.webContents.on('console-message', (_event, ...args) => console.log('[renderer]', ...args));
  window.webContents.on('render-process-gone', (_event, details) => { console.error('Renderer terminated', details); app.exit(1); });
  try {
    await window.loadURL(`${scheme}://app/index.html`);
    await window.webContents.executeJavaScript('window.editorAssetsReady');
    const result = await window.webContents.executeJavaScript('({result:window.editorAssetsResults,error:window.editorAssetsError})');
    writeFileSync(join(logs, 'results.json'), JSON.stringify(result, null, 2));
    if (result.error || !result.result?.passed) throw new Error(result.error || 'The dependency fixture did not complete');
    writeFileSync(join(logs, 'diagram.png'), (await window.webContents.capturePage()).toPNG());
    console.log(`Editor dependency assets: ${result.result.passed} checks passed`);
    console.log(JSON.stringify(result.result));
    clearTimeout(timeout);
    window.destroy();
    app.exit(0);
  } catch (error) {
    rendererErrors.push(error?.stack ?? String(error));
    const detail = await window.webContents.executeJavaScript('({error:window.editorAssetsError,progress:window.editorAssetsProgress})').catch(() => undefined);
    writeFileSync(join(logs, 'failure.json'), JSON.stringify({ errors: rendererErrors, detail }, null, 2));
    console.error(detail?.error || error?.stack || String(error));
    clearTimeout(timeout);
    window.destroy();
    app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
