import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { registerAppScheme } from '../main/app/protocol';
import { kvSet } from '../main/services/settings';
import { Harness, assert, assertEqual, waitFor } from './harness';

const root = process.env.KLAUS_ANTIGRAVITY_UI_PROFILE;
if (!root) throw new Error('This fixture requires an isolated KLAUS_ANTIGRAVITY_UI_PROFILE.');
process.env.KLAUS_CONFIG_DIR = root;
process.env.KLAUS_TEST = '1';
mkdirSync(join(root, 'electron'), { recursive: true });
app.setPath('userData', join(root, 'electron'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
registerAppScheme();
app.on('window-all-closed', () => {});
const h = new Harness();

void (async () => {
  let runtime: DesktopRuntime | undefined, startupFailed = false;
  try {
    await app.whenReady();
    writeFileSync(join(root, 'klaus-guest-mode'), '1', { mode: 0o600 });
    for (const [key, value] of Object.entries({ auth_mode: 'custom', global_shortcut: 'off', quick_input_shortcut: 'off', 'notification.desktop': 'off', 'notification.sound': 'off', 'mobile_bridge.enabled': '0', 'external_agent_import.onboarding_dismissed': '1' })) kvSet(key, value, root);
    runtime = await createDesktopRuntime(app, { show: false, tray: false });
    const desktop = runtime;
    const evaluate = <T>(code: string): Promise<T> => desktop.window.webContents.executeJavaScript(code) as Promise<T>;
    await waitFor(() => evaluate<boolean>('Boolean(window.klaus && window.__KLAUS_DESKTOP__)'), 30_000, 'the application bridge loads');
    await waitFor(() => evaluate<boolean>("!document.getElementById('boot-screen') || getComputedStyle(document.getElementById('boot-screen')).display === 'none'"), 30_000, 'the application starts');
    await waitFor(() => evaluate<boolean>("typeof window.openSettings === 'function'"), 30_000, 'the settings entry point loads');
    desktop.show();
    desktop.window.setContentSize(1280, 900);

    await h.test('the real settings page exposes independent browser login and local reuse', async () => {
      await evaluate("window.openSettings('models'); true");
      await waitFor(() => evaluate<boolean>('Boolean(document.querySelector(\'[data-source-tab="antigravity"]\'))'), 30_000, 'the Antigravity model source appears');
      await evaluate('document.querySelector(\'[data-source-tab="antigravity"]\').click(); true');
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('antigravity-auth-login-btn'))"), 30_000, 'the browser login action appears');
      const state = await evaluate<{ selected: string; action: string; reuse: string; actions: number; keyInputs: number }>(`(() => ({
        selected: document.querySelector('[data-source-tab="antigravity"]')?.getAttribute('aria-selected'),
        action: document.getElementById('antigravity-auth-login-btn')?.textContent || '',
        reuse: document.getElementById('antigravity-auth-import-btn')?.textContent || '',
        actions: document.getElementById('antigravity-auth-login-btn')?.closest('.settings-card')?.querySelectorAll('button').length || 0,
        keyInputs: document.querySelectorAll('#antigravity-auth-apikey-block input').length,
      }))()`);
      assertEqual(state.selected, 'true', 'the selected source has its own tab');
      assert(state.action.length > 0 && !state.action.includes('_'), 'the account action is localized');
      assert(state.reuse.length > 0 && !state.reuse.includes('_'), 'the local reuse action is localized');
      assertEqual(state.actions, 2, 'the signed-out account has exactly two actions');
      assertEqual(state.keyInputs, 0, 'account adoption requires no pasted API key');
      writeFileSync(join(root, 'antigravity-settings.png'), (await desktop.window.webContents.capturePage()).toPNG());
    });

    await h.test('the native account button adopts the installed login and discovers concrete model rows', async () => {
      await evaluate("document.getElementById('antigravity-auth-import-btn').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('.klaus-dialog-overlay.active .klaus-dialog-confirm'))"), 10_000, 'local account reuse asks for confirmation');
      await evaluate("document.querySelector('.klaus-dialog-overlay.active .klaus-dialog-confirm').click(); true");
      await waitFor(() => evaluate<boolean>("window.klaus.antigravityAuth.status().then(status => status.loggedIn === true && status.needsLogin !== true)"), 90_000, 'the account connects through the real host');
      await waitFor(() => evaluate<boolean>("!document.getElementById('antigravity-auth-login-btn') && !document.getElementById('antigravity-auth-import-btn')"), 30_000, 'connected account actions disappear');
      assertEqual(await evaluate<number>("document.getElementById('antigravity-auth-card')?.querySelectorAll('button').length ?? -1"), 0, 'the connected account card has no buttons');
      const state = await evaluate<{ connected: boolean; source: string; models: number; unavailable: number }>(`(async () => {
        const status = await window.klaus.antigravityAuth.status();
        const saved = await window.klaus.session.getMainModel(undefined, {resolve:false});
        const catalog = await window.klaus.antigravityAuth.models();
        return { connected:status.loggedIn===true, source:saved.source, models:catalog.models.length,
          unavailable:catalog.models.filter(row=>row.disabled===true || row.unavailable===true).length };
      })()`);
      assertEqual(state.connected, true, 'the engine owns the adopted account');
      assertEqual(state.source, 'antigravity', 'the model-source preference follows successful adoption');
      assert(state.models > 0, 'the account has a concrete service catalog');
      assert(state.unavailable > 0, 'unoffered account models retain explicit unavailable rows');
    });

    await h.test('the real renderer bridge exposes quota and independent image/search availability', async () => {
      const state = await evaluate<{ mode: string; windows: number; image: boolean; search: boolean }>(`(async () => {
        const usage = await window.klaus.usage.subscriptions();
        const images = await window.klaus.settings.imageSelection.get();
        const search = await window.klaus.settings.webSearchSources.get();
        return { mode:usage.snapshot.mode, windows:(usage.snapshot.provider.windows||[]).length,
          image:images.availability.antigravity===true, search:search.availability?.antigravity===true };
      })()`);
      assertEqual(state.mode, 'antigravity', 'quota reads the chosen source');
      assert(state.windows > 0, 'the quota display has real service windows');
      assertEqual(state.image, true, 'the image backend uses declared source capabilities');
      assertEqual(state.search, true, 'the search backend uses declared source capabilities');
    });

    await h.test('disconnect through the account API leaves both recovery actions available', async () => {
      await evaluate('window.klaus.antigravityAuth.logout()');
      await waitFor(() => evaluate<boolean>("window.klaus.antigravityAuth.status().then(status => status.loggedIn === false)"), 30_000, 'the isolated account disconnects');
      const status = await evaluate<{ loggedIn: boolean }>('window.klaus.antigravityAuth.status()');
      assertEqual(status.loggedIn, false, 'no stale connected status survives logout');
      await evaluate("window.openSettings('models'); true");
      await waitFor(() => evaluate<boolean>('Boolean(document.querySelector(\'[data-source-tab="antigravity"]\'))'), 30_000, 'the source tab remains available');
      await evaluate('document.querySelector(\'[data-source-tab="antigravity"]\').click(); true');
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('antigravity-auth-login-btn')) && Boolean(document.getElementById('antigravity-auth-import-btn'))"), 30_000, 'both account recovery actions remain visible');
    });
  } catch (error) {
    startupFailed = true;
    console.error(error instanceof Error ? error.stack : String(error));
  } finally {
    try { await runtime?.shutdown(); } catch { startupFailed = true; }
    const code = await h.finish(join(root, 'antigravity-ui-result.json'), 'antigravity-ui');
    app.exit(startupFailed || code !== 0 ? 1 : 0);
  }
})();
