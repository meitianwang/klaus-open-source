import { app } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { registerAppScheme } from '../main/app/protocol';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { kvSet } from '../main/services/settings';
import { currentDesktopEdition } from '../main/services/desktop-edition';
import { claimDesktopProfileEdition } from '../main/services/desktop-profile';
import { waitFor } from './harness';

const root = process.env.KLAUS_COMPUTER_SETTINGS_PROFILE, logs = process.env.KLAUS_COMPUTER_SETTINGS_LOGS;
if (!root || !logs) throw new Error('An isolated profile and evidence directory are required');
process.env.KLAUS_CONFIG_DIR = root; process.env.CANONICAL_CWD = root; process.env.KLAUS_TEST = '1';
claimDesktopProfileEdition(root, currentDesktopEdition());
app.setPath('userData', join(root, 'electron')); registerAppScheme();
app.on('window-all-closed', () => {});
void (async () => {
  let runtime: DesktopRuntime | undefined, code = 1;
  try {
    await app.whenReady();
    for (const key of ['global_shortcut', 'quick_input_shortcut']) kvSet(key, 'off', root);
    kvSet('computer_use.allowed_apps', '["LM Studio","Shadowrocket"]', root);
    writeFileSync(join(root, 'klaus-guest-mode'), '1', { mode: 0o600 });
    runtime = await createDesktopRuntime(app, { show: false, tray: false, externalImportHome: root });
    const window = runtime.window;
    await waitFor(() => window.webContents.executeJavaScript(`Boolean(window.openSettings && document.getElementById('boot-screen') && getComputedStyle(document.getElementById('boot-screen')).display === 'none')`), 15_000, 'desktop startup');
    await window.webContents.executeJavaScript('window.openSettings("computerUse")');
    await waitFor(() => window.webContents.executeJavaScript(`document.querySelectorAll('#settings-content [data-app]').length === 2`), 10_000, 'saved apps through the real preload');
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('#settings-content [role=switch],#settings-content input').length`), 0);
    const details = await window.webContents.executeJavaScript(`window.klaus.settings.computerUse.appDetails("LM Studio")`);
    assert.equal(typeof details.name, 'string');
    assert.match(details.iconDataUrl, /^data:image\/png;base64,/);
    await waitFor(() => window.webContents.executeJavaScript(`document.querySelectorAll('#settings-content [data-app] img').length === 2`), 8000, 'native application icons');
    writeFileSync(join(logs, 'runtime-settings.png'), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`document.querySelector('#settings-content [data-app] button').click()`);
    await waitFor(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('dialog:modal'))`), 5000, 'remove dialog');
    const saved = await window.webContents.executeJavaScript('window.klaus.settings.computerUse.get()');
    assert.deepEqual(saved.allowedApps, ['LM Studio', 'Shadowrocket']);
    writeFileSync(join(logs, 'runtime-confirm.png'), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`document.querySelector('dialog footer button:last-child').click()`);
    await waitFor(() => window.webContents.executeJavaScript(`document.querySelectorAll('#settings-content [data-app]').length === 1 && !document.querySelector('dialog')`), 5000, 'durable removal');
    assert.deepEqual((await window.webContents.executeJavaScript('window.klaus.settings.computerUse.get()')).allowedApps, ['Shadowrocket']);
    await window.webContents.executeJavaScript('window.closeSettings(); window.openSettings("computerUse")');
    await waitFor(() => window.webContents.executeJavaScript(`document.querySelectorAll('#settings-content [data-app]').length === 1`), 5000, 'reopened page');
    const registered = runtime.registry.channels(), contract = JSON.parse(readFileSync(join(__dirname, '../../contracts/channel-table.json'), 'utf8'));
    const required = [...new Set<string>(contract.roles.flatMap((role: { invoke: string[] }) => role.invoke))];
    const missing = required.filter(channel => !registered.includes(channel)), extra = registered.filter(channel => !required.includes(channel));
    assert.deepEqual(missing, []); assert.deepEqual(extra, []);
    await runtime.shutdown();
    const result = { required: required.length, registered: registered.length, missing, extra, nativeIcons: true, durableRemoval: true, reopened: true,
      engineAfterShutdown: runtime.engine.liveProcessCount(), nativeAfterShutdown: runtime.nativeCounts() };
    assert.equal(result.engineAfterShutdown, 0);
    writeFileSync(join(logs, 'runtime-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result)); code = 0;
  } catch (error) { console.error(error); }
  finally { await runtime?.shutdown(); app.exit(code); }
})();
