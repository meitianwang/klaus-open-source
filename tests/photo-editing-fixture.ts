import { app, BrowserWindow, ipcMain, nativeImage, protocol, webContents, type WebContentsView } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PhotoEditingService } from '../main/photo-editing/service';
import { registerPhotoEditingHandlers } from '../main/ipc/handlers/photo-editing';
import { ChannelRegistry } from '../main/ipc/registry';
import { RoleTable } from '../main/ipc/contract';
import { IpcRouter } from '../main/ipc/router';
import { handleCoreInvoke, WindowRoleRegistry } from '../main/ipc/binding';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { appUrl, APP_SCHEME, registerAppScheme } from '../main/app/protocol';
import { record, type Data } from '../main/visuals/data';
import { assert, assertEqual, Harness, waitFor } from './harness';
const { officialPluginRoot } = require('../../scripts/official-plugin-root.cjs') as typeof import('../scripts/official-plugin-root.cjs');
const photoPluginRoot = officialPluginRoot('photo-editing');

const profile = process.env.KLAUS_PHOTO_EDITING_FIXTURE_PROFILE;
if (!profile) throw new Error('An isolated photo-editing fixture profile is required.');
const workspaceDir = join(profile, 'workspace');
mkdirSync(workspaceDir, { recursive: true });
const logs = resolve(__dirname, '../photo-editing-logs');
mkdirSync(logs, { recursive: true });

app.setPath('userData', profile);
registerAppScheme();
app.on('window-all-closed', () => {});

async function main(): Promise<number> {
  await app.whenReady();
  const h = new Harness();
  const deadline = setTimeout(() => {
    appendFileSync(join(logs, 'fixture-progress.log'), 'Fixture deadline exceeded.\n');
    app.exit(1);
  }, 110_000);
  const test = (name: string, body: () => Promise<void>): Promise<void> => h.test(name, async () => {
    appendFileSync(join(logs, 'fixture-progress.log'), `${new Date().toISOString()} START ${name}\n`);
    try { await body(); }
    finally { appendFileSync(join(logs, 'fixture-progress.log'), `${new Date().toISOString()} END ${name}\n`); }
  });

  protocol.handle(APP_SCHEME, () => new Response(
    '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><h1>Photo editing host fixture</h1>',
    { headers: { 'Content-Type': 'text/html' } },
  ));
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  await window.loadURL(appUrl('index.html'));

  const roles = new WindowRoleRegistry();
  const registry = new ChannelRegistry();
  let fixtureLanguage = 'zh-CN';
  const service = new PhotoEditingService({
    configRoot: profile!,
    window,
    enabled: () => true,
    pluginRoot: () => photoPluginRoot,
    language: () => fixtureLanguage,
    readRoots: () => [workspaceDir],
    writeRoots: () => [workspaceDir],
    registerRenderer: (id, role) => {
      roles.register(id, role);
      webContents.fromId(id)?.on('console-message', (event) => {
        appendFileSync(join(logs, 'editor-console.txt'), JSON.stringify({
          level: event.level,
          message: event.message,
          lineNumber: event.lineNumber,
          sourceId: event.sourceId,
        }) + '\n');
      });
    },
    unregisterRenderer: id => roles.unregister(id),
    emit: (channel, data) => appendFileSync(join(logs, 'editor-events.txt'), JSON.stringify({ channel, data }) + '\n'),
    log: (event, data) => appendFileSync(join(logs, 'editor-events.txt'), JSON.stringify({ event, data }) + '\n'),
  });
  registerPhotoEditingHandlers(registry, { service });
  const router = new IpcRouter({ registry, roles: RoleTable.load() });
  ipcMain.handle(HOST_CHANNELS.coreInvoke, (event, payload: unknown) => {
    const fields = record(payload);
    return handleCoreInvoke({
      roleOf: id => roles.resolver()(id),
      route: (caller, channel, args) => router.route(caller, channel, args),
      windowOp: () => { throw new Error('The photo-editing runtime has no window actions.'); },
    }, event, String(fields.command), fields.args);
  });

  const invoke = async (channel: string, fields: Data = {}): Promise<Data> => {
    const handler = registry.lookup(channel);
    assert(handler, `${channel} registered`);
    return record(await handler({ role: 'main', senderId: window.webContents.id, channel, args: [fields] }));
  };

  const owner = 'photo-fixture-session';
  let id = '';
  let view: WebContentsView;

  const call = async (name: string, fields: Data = {}): Promise<Data> => {
    const response = await service.call(owner, name, { ...(id ? { id } : {}), ...fields });
    assert(response.isError !== true, JSON.stringify(response));
    return record(response.structuredContent);
  };

  const child = (projectId: string): WebContentsView => {
    const found = window.contentView.children.find(candidate =>
      'webContents' in candidate && new URL((candidate as WebContentsView).webContents.getURL()).searchParams.get('id') === projectId,
    ) as WebContentsView;
    assert(found, `editor view for ${projectId}`);
    return found;
  };

  await test('photo_open creates a blank canvas, boots WASM editor in isolated preload, and renders UI in Chinese', async () => {
    const opened = await call('photo_open', {
      title: '春季新品主视觉',
      width: 960,
      height: 640,
      background: 'white',
    });
    writeFileSync(join(logs, '01-open.json'), JSON.stringify(opened, null, 2));
    id = String(opened.id);
    assert(id.length > 0, 'workspace id returned');
    assertEqual(record(opened.artifact).kind, 'photo-editing', 'artifact kind is photo-editing');
    assertEqual(record(opened.artifact).ready, true, 'created canvas document publishes ready artifact');

    assertEqual(
      (await invoke('photo-editing:panel-show', { id, sessionId: owner, bounds: { x: 0, y: 0, width: 1280, height: 860 } })).ok,
      true,
      'panel shown',
    );
    window.showInactive();
    view = child(id);

    await waitFor(
      async () => Boolean(await view.webContents.executeJavaScript(
        'Boolean(document.getElementById("startup")?.hidden && document.querySelector("canvas") && document.querySelector("canvas").width > 0)',
      )),
      25_000,
      'WASM editor startup completes and mounts WebGL/2D canvas',
    );

    const uiState = record(await view.webContents.executeJavaScript('window.klausPhotoEditing.request({ method: "ui.language", params: {} })'));
    writeFileSync(join(logs, '02-ui-state-zh.json'), JSON.stringify(uiState, null, 2));
    assertEqual(uiState.result, 'zh-hans', 'editor respects Chinese host locale');

    // Verify least-privilege role boundary: isolated view cannot invoke main-window channels.
    const denied = await view.webContents.executeJavaScript(`
      window.klausPhotoEditingHost ? 'bridge-present' : 'missing'
    `);
    assertEqual(denied, 'bridge-present', 'scoped photo-editing preload bridge exposed');
    const mainGlobal = await view.webContents.executeJavaScript('typeof window.klaus');
    assertEqual(mainGlobal, 'undefined', 'main host bridge is never exposed inside photo-editing runtime');
  });

  await test('photo_commands, photo_place, and photo_execute compose Smart Objects, adjustment layers, and CJK typography', async () => {
    const catalog = await call('photo_commands', { query: 'brightnessContrast' });
    const commandList = Array.isArray(catalog.commands) ? catalog.commands : record(catalog.commands).commands;
    assert(Array.isArray(commandList) && commandList.length >= 1, 'searchable command catalog locates adjustment commands');

    // Generate a crisp 320x220 BGRA/RGBA gradient card with a highlight badge via nativeImage.createFromBitmap.
    const bmpW = 320, bmpH = 220;
    const raw = Buffer.alloc(bmpW * bmpH * 4);
    for (let y = 0; y < bmpH; y++) {
      for (let x = 0; x < bmpW; x++) {
        const offset = (y * bmpW + x) * 4;
        const dx = x - 236, dy = y - 78;
        const inBadge = dx * dx + dy * dy <= 42 * 42;
        if (inBadge) {
          // BGRA on macOS/Windows Skia bitmaps: warm coral accent circle
          raw[offset] = 110;
          raw[offset + 1] = 148;
          raw[offset + 2] = 248;
          raw[offset + 3] = 255;
        } else {
          const t = (x / bmpW) * 0.6 + (y / bmpH) * 0.4;
          raw[offset] = Math.round(132 + 85 * t);     // B
          raw[offset + 1] = Math.round(147 - 40 * t); // G
          raw[offset + 2] = Math.round(24 + 100 * t); // R
          raw[offset + 3] = 255;
        }
      }
    }
    const pngBytes = nativeImage.createFromBitmap(raw, { width: bmpW, height: bmpH }).toPNG();
    assert(pngBytes.length > 256, 'generated non-empty PNG test asset');
    const assetPath = join(workspaceDir, 'product-card.png');
    writeFileSync(assetPath, pngBytes);

    const beforePlace = await call('photo_inspect', {});
    const placed = await call('photo_place', {
      expected_version: Number(beforePlace.version),
      path: assetPath,
      layer_name: 'Product Hero',
      fit: true,
    });
    writeFileSync(join(logs, '03-placed.json'), JSON.stringify(placed, null, 2));
    assert(Number(placed.version) > Number(beforePlace.version), 'placing Smart Object persists a new workspace version');

    // Path confinement check: reading outside workspaceDir must fail cleanly.
    const escapedRead = await service.call(owner, 'photo_place', {
      id,
      expected_version: Number(placed.version),
      path: join(profile!, 'outside.png'),
    });
    assertEqual(escapedRead.isError, true, 'path outside workspace readRoots is rejected');

    // Stale expected_version check.
    const staleEdit = await service.call(owner, 'photo_execute', {
      id,
      expected_version: 0,
      commands: [{ command: 'layer.new.layer', params: { name: 'Stale' } }],
    });
    assertEqual(staleEdit.isError, true, 'stale expected_version is rejected');

    const latestVersion = Number(placed.version);
    const executed = await call('photo_execute', {
      expected_version: latestVersion,
      commands: [
        {
          command: 'layer.newAdjustmentLayer.brightnessContrast',
          params: { brightness: 12, contrast: 18 },
        },
        {
          command: 'type.create',
          params: {
            text: '春季焕新 · Photo Editing',
            name: 'Headline',
            x: 96,
            y: 160,
            font: 'Noto Sans SC',
            size: 52,
            color: '#1c2030',
            align: 'left',
          },
        },
      ],
    });
    writeFileSync(join(logs, '04-executed.json'), JSON.stringify(executed, null, 2));
    assert(Number(executed.version) > latestVersion, 'batch command execution advances saved version');

    const inspected = await call('photo_inspect', { detail: true });
    writeFileSync(join(logs, '05-inspected.json'), JSON.stringify(inspected, null, 2));
    const treeJson = JSON.stringify(inspected);
    assert(treeJson.includes('Product Hero'), 'inspected layer tree contains placed Smart Object layer');
    assert(treeJson.includes('春季焕新'), 'inspected layer tree contains CJK text layer');
  });

  await test('language switching, photo_preview, and photo_export (.psd, .png, .pcraft) work end-to-end and persist across reopen', async () => {
    fixtureLanguage = 'en-US';
    service.refreshLanguage();
    await waitFor(async () => {
      const ui = record(await view.webContents.executeJavaScript('window.klausPhotoEditing.request({ method: "ui.language", params: {} })'));
      return ui.result === 'en';
    }, 5_000, 'runtime switches to English');

    fixtureLanguage = 'zh-CN';
    service.refreshLanguage();
    await waitFor(async () => {
      const ui = record(await view.webContents.executeJavaScript('window.klausPhotoEditing.request({ method: "ui.language", params: {} })'));
      return ui.result === 'zh-hans';
    }, 5_000, 'runtime switches back to Simplified Chinese');

    const previewPath = join(workspaceDir, 'preview.png');
    const preview = await call('photo_preview', { output_path: previewPath, max_side: 640 });
    writeFileSync(join(logs, '06-preview.json'), JSON.stringify(preview, null, 2));
    assert(existsSync(previewPath), 'preview PNG written');
    const previewBytes = readFileSync(previewPath);
    assertEqual(previewBytes[0], 0x89, 'preview has PNG signature');
    assert(Number(preview.width) <= 640 && Number(preview.height) <= 640, 'preview respects max_side');

    const psdPath = join(workspaceDir, 'deliverable.psd');
    const pngPath = join(workspaceDir, 'deliverable.png');
    const pcraftPath = join(workspaceDir, 'deliverable.pcraft');
    const psdOut = await call('photo_export', { output_path: psdPath, format: 'psd' });
    const pngOut = await call('photo_export', { output_path: pngPath, format: 'png' });
    const pcraftOut = await call('photo_export', { output_path: pcraftPath, format: 'pcraft' });
    writeFileSync(join(logs, '07-exports.json'), JSON.stringify({ psdOut, pngOut, pcraftOut }, null, 2));

    assertEqual(readFileSync(psdPath).subarray(0, 4).toString('ascii'), '8BPS', 'exported PSD starts with 8BPS header');
    assertEqual(readFileSync(pngPath)[0], 0x89, 'exported PNG starts with PNG signature');
    assertEqual(readFileSync(pcraftPath).subarray(0, 2).toString('ascii'), 'PK', 'exported .pcraft starts with ZIP PK signature');

    // Escape check on export path.
    const escapedExport = await service.call(owner, 'photo_export', {
      id,
      output_path: join(profile!, 'escaped.png'),
      format: 'png',
    });
    assertEqual(escapedExport.isError, true, 'export outside workspace writeRoots is rejected');

    writeFileSync(join(logs, 'preview-640.png'), previewBytes);
    writeFileSync(join(logs, 'deliverable-composite.png'), readFileSync(pngPath));

    // Mount the WebContentsView via photo-editing:panel-show and capture the live WebContentsView via CDP Page.captureScreenshot.
    const shown = await invoke('photo-editing:panel-show', { id, sessionId: owner, bounds: { x: 0, y: 0, width: 1280, height: 860 } });
    assertEqual(shown.ok, true, 'photo-editing:panel-show succeeds');
    window.showInactive();
    await view.webContents.executeJavaScript('window.klausPhotoEditing.request({ method: "ui.language", params: {} })');
    await view.webContents.executeJavaScript('new Promise(resolve => { requestAnimationFrame(() => requestAnimationFrame(resolve)); setTimeout(resolve, 450); })');
    let panelPng: Buffer;
    try {
      if (!view.webContents.debugger.isAttached()) {
        view.webContents.debugger.attach('1.3');
      }
      const cdpShot = record(await view.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }));
      panelPng = Buffer.from(String(cdpShot.data ?? ''), 'base64');
    } finally {
      if (view.webContents.debugger.isAttached()) {
        view.webContents.debugger.detach();
      }
      window.hide();
    }
    assert(panelPng.length > 1024, 'captured non-empty live panel PNG bytes');
    writeFileSync(join(logs, 'photo-editing-panel-e2e.png'), panelPng);

    // Tear down live view & reopen from persisted generation on disk.
    await invoke('photo-editing:panel-close');
    service.releaseSession(owner);

    const reopenedInspect = await call('photo_inspect', { detail: true });
    const reopenedJson = JSON.stringify(reopenedInspect);
    assert(reopenedJson.includes('Product Hero'), 'reopened workspace preserves Smart Object layer from disk');
    assert(reopenedJson.includes('春季焕新'), 'reopened workspace preserves CJK typography layer from disk');
  });

  clearTimeout(deadline);
  service.dispose();
  window.destroy();
  return h.finish(join(logs, 'photo-editing-fixture-result.json'), 'photo-editing-fixture');
}

void main().then(code => app.exit(code)).catch(error => {
  appendFileSync(join(logs, 'fixture-progress.log'), `FATAL ${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
