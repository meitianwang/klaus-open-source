import { app, BrowserWindow, session as electronSession } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { BrowserExtensionManager } from '../main/browser/extension-manager';
import { Harness, assert, assertEqual, sleep, waitFor } from './harness';

const profile = process.env.KLAUS_BROWSER_EXTENSIONS_PROFILE;
const fixture = process.env.KLAUS_BROWSER_EXTENSIONS_FIXTURE;
if (!profile || !fixture) throw new Error('This fixture requires an isolated profile and synthetic extension source.');
const profileRoot = profile;
const fixtureRoot = fixture;
mkdirSync(profileRoot, { recursive: true });
app.setPath('userData', profileRoot);
app.on('window-all-closed', () => {});

class ElectronExtensionLoader {
  constructor(private readonly ses: Electron.Session) {}

  async loadExtension(path: string, options: { allowFileAccess: boolean }) {
    const extension = await this.ses.extensions.loadExtension(path, options);
    return {
      id: extension.id,
      name: extension.name,
      version: extension.version,
      path: extension.path,
      manifest: extension.manifest as Record<string, unknown>,
    };
  }

  removeExtension(id: string): void {
    this.ses.extensions.removeExtension(id);
  }
}

async function main(): Promise<number> {
  await app.whenReady();
  const h = new Harness();
  const ses = electronSession.fromPartition('persist:klaus-synthetic-extension-fixture');
  const window = new BrowserWindow({
    show: false,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><title>${request.url}</title><p>extension fixture</p>`);
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const config = join(profileRoot, 'extension-config');
  const source = join(profileRoot, 'selected-extension');
  await mkdir(source, { recursive: true });
  await copyFile(join(fixtureRoot, 'manifest.json'), join(source, 'manifest.json'));
  await copyFile(join(fixtureRoot, 'content.js'), join(source, 'content.js'));

  let manager = new BrowserExtensionManager({ directory: config, extensions: new ElectronExtensionLoader(ses) });
  await manager.initialize();
  let extensionId = '';

  const marker = async (): Promise<string | null> => window.webContents.executeJavaScript(
    "document.documentElement.getAttribute('data-klaus-synthetic-extension')",
  );

  h.test('a real MV3 extension is loaded and runs its content script', async () => {
    const installed = await manager.install({ path: source });
    assertEqual(installed.loaded, true, 'installation reports a loaded extension');
    assertEqual(installed.name, 'Synthetic extension fixture', 'manifest name is read from the real loader');
    assert(/^[a-p]{32}$/u.test(installed.id), `loader returned a 32-character extension id: ${installed.id}`);
    assert(ses.extensions.getAllExtensions().some(extension => extension.id === installed.id), 'the dedicated session contains the extension');
    extensionId = installed.id;
    await window.loadURL(`${base}/first`);
    await waitFor(async () => (await marker()) === extensionId, 5000, 'the content script writes the extension id');
  });

  h.test('disabling removes the extension and a new navigation stays clean', async () => {
    const disabled = await manager.setEnabled(extensionId, false);
    assertEqual(disabled.loaded, false, 'the disabled row is not loaded');
    assertEqual(ses.extensions.getAllExtensions().some(extension => extension.id === extensionId), false, 'the dedicated session no longer contains the extension');
    await window.loadURL(`${base}/disabled`);
    await sleep(400);
    assertEqual(await marker(), null, 'a new document does not receive the disabled content script');
  });

  h.test('restarting the manager restores the enabled extension', async () => {
    await manager.setEnabled(extensionId, true);
    manager.dispose();
    assertEqual(ses.extensions.getAllExtensions().some(extension => extension.id === extensionId), false, 'dispose unloads the extension before restart');
    manager = new BrowserExtensionManager({ directory: config, extensions: new ElectronExtensionLoader(ses) });
    await manager.initialize();
    const rows = await manager.list();
    assertEqual(rows.length, 1, 'the registry restores one extension');
    assertEqual(rows[0]?.id, extensionId, 'the restored identity is stable');
    assertEqual(rows[0]?.loaded, true, 'the restored extension is loaded');
    await window.loadURL(`${base}/restarted`);
    await waitFor(async () => (await marker()) === extensionId, 5000, 'the restored content script runs after restart');
  });

  h.test('removing a registration leaves its selected source directory intact', async () => {
    await manager.remove(extensionId);
    assertEqual(await manager.list().then(rows => rows.length), 0, 'the registration is gone');
    assertEqual(ses.extensions.getAllExtensions().some(extension => extension.id === extensionId), false, 'the extension is unloaded');
    assertEqual(existsSync(join(source, 'manifest.json')), true, 'remove never deletes the manifest');
    assertEqual(existsSync(join(source, 'content.js')), true, 'remove never deletes source files');
  });

  h.test('copied files without a registry record are not reported as installed', async () => {
    const copied = join(config, 'copied-extension');
    await mkdir(copied, { recursive: true });
    await copyFile(join(fixtureRoot, 'manifest.json'), join(copied, 'manifest.json'));
    await copyFile(join(fixtureRoot, 'content.js'), join(copied, 'content.js'));
    const fresh = new BrowserExtensionManager({ directory: config, extensions: new ElectronExtensionLoader(ses) });
    await fresh.initialize();
    assertEqual(await fresh.list().then(rows => rows.length), 0, 'the registry, not a copied folder, defines installed extensions');
    assertEqual(ses.extensions.getAllExtensions().some(extension => extension.id === extensionId), false, 'the copied folder was never loaded');
    fresh.dispose();
  });

  const code = await h.finish(join(__dirname, 'browser-extensions-electron-result.json'), 'browser-extensions-electron');
  manager.dispose();
  window.destroy();
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  return code;
}

void main().then(code => { process.exitCode = code; app.quit(); }).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
  app.quit();
});
