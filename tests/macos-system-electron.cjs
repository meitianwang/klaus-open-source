const { app, BrowserWindow, screen, nativeImage } = require('electron');
const strict = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MacOsConnectors } = require('../dist/main/services/macos-connectors/service');
const { Harness, waitFor } = require('../dist/tests/harness');
if (!process.env.KLAUS_SYSTEM_FIXTURE_ROOT) throw new Error('Use the owned System test launcher');
const directory = fs.realpathSync(process.env.KLAUS_SYSTEM_FIXTURE_ROOT);
app.setPath('userData', path.join(directory, 'profile'));
const h = new Harness(); let window, service;
app.whenReady().then(async () => {
  const bounds = screen.getPrimaryDisplay().workArea;
  window = new BrowserWindow({ x: bounds.x + 100, y: bounds.y + 100, width: 360, height: 260, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<title>Klaus owned system fixture</title><style>html,body{margin:0;background:%23139c66;height:100%}</style>');
  window.show(); window.focus();
  await waitFor(() => window.isFocused(), 3000, 'owned fixture focus');
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  service = new MacOsConnectors({ configRoot: directory, userHome: directory }); service.attachSession('fixture');
  const context = { sessionId: 'fixture', turnId: 'capture', signal: new AbortController().signal,
    assertCurrent() { if (!window.isFocused()) throw new Error('The owned fixture is not focused'); },
    elicit: async () => ({ action: 'accept' }), workdir: directory };
  h.test('the actual system screenshot contains only the requested eight-point owned color region', async () => {
    const bounds = window.getContentBounds(), region = `${bounds.x + 60},${bounds.y + 60},8,8`;
    const result = await service.call('macos-system', 'capture_screen', { region }, context);
    const filename = result.content[0].text.slice('Saved screenshot to '.length), image = nativeImage.createFromPath(filename);
    const size = image.getSize(), bitmap = image.toBitmap();
    strict.ok(size.width >= 8 && size.width <= 32 && size.height >= 8 && size.height <= 32);
    strict.equal(bitmap.length, size.width * size.height * 4);
    const middle = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4;
    const color = { red: bitmap[middle + 2], green: bitmap[middle + 1], blue: bitmap[middle], alpha: bitmap[middle + 3] };
    strict.ok(color.red < 70 && color.green > 110 && color.green < 200 && color.blue > 50 && color.blue < 150 && color.alpha === 255);
    console.log('owned_system_capture=' + JSON.stringify({ region, size, color }));
  });
  h.test('the actual Spotlight command stays within its owned fixture directory', async () => {
    const result = await service.call('macos-system', 'spotlight_search', { onlyin: directory, query: 'KlausNoMatchingSystemFixture_951d9c47' }, context);
    const value = JSON.parse(result.content[0].text); strict.equal(value.count, 0); strict.deepEqual(value.paths, []);
  });
  h.test('the system owner drains and rejects subsequent tool calls', async () => {
    strict.deepEqual(await service.detachSession('fixture'), { complete: true }); strict.deepEqual(await service.close(), { complete: true });
    await strict.rejects(service.call('macos-system', 'capture_screen', { region: '0,0,8,8' }, context), /not active/);
  });
  const code = await h.finish(path.join(directory, 'result.json'), 'macos-system-electron'); await cleanup(); app.exit(code);
}).catch(async error => { console.error(error); await cleanup(); app.exit(1); });
async function cleanup() {
  if (service) strict.deepEqual(await service.close(), { complete: true });
  if (window && !window.isDestroyed()) window.destroy();
}
