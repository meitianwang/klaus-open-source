import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { registerAppScheme } from '../main/app/protocol';
import { kvSet } from '../main/services/settings';
import { Harness, assert, assertEqual, waitFor } from './harness';

const root = process.env.KLAUS_TRAE_UI_PROFILE;
if (!root) throw new Error('This fixture requires an isolated KLAUS_TRAE_UI_PROFILE.');
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
      await waitFor(() => evaluate<boolean>('Boolean(document.querySelector(\'[data-source-tab="trae"]\'))'), 30_000, 'the TRAE CN model source appears');
      await evaluate('document.querySelector(\'[data-source-tab="trae"]\').click(); true');
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('trae-auth-login-btn'))"), 30_000, 'the browser login action appears');
      const state = await evaluate<{ selected: string; action: string; reuse: string; actions: number; keyInputs: number }>(`(() => ({
        selected: document.querySelector('[data-source-tab="trae"]')?.getAttribute('aria-selected'),
        action: document.getElementById('trae-auth-login-btn')?.textContent || '',
        reuse: document.getElementById('trae-auth-import-btn')?.textContent || '',
        actions: document.getElementById('trae-auth-login-btn')?.closest('.settings-card')?.querySelectorAll('button').length || 0,
        keyInputs: document.querySelectorAll('#trae-auth-apikey-block input').length,
      }))()`);
      assertEqual(state.selected, 'true', 'the selected source has its own tab');
      assert(state.action.length > 0 && !state.action.includes('_'), 'the account action is localized');
      assert(state.reuse.length > 0 && !state.reuse.includes('_'), 'the local reuse action is localized');
      assertEqual(state.actions, 2, 'the signed-out account has exactly two actions');
      assertEqual(state.keyInputs, 0, 'account adoption requires no pasted API key');
      writeFileSync(join(root, 'trae-settings.png'), (await desktop.window.webContents.capturePage()).toPNG());
    });

    await h.test('the native account button adopts the installed login and discovers concrete model rows', async () => {
      await evaluate("document.getElementById('trae-auth-import-btn').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('.klaus-dialog-overlay.active .klaus-dialog-confirm'))"), 10_000, 'local account reuse asks for confirmation');
      await evaluate("document.querySelector('.klaus-dialog-overlay.active .klaus-dialog-confirm').click(); true");
      await waitFor(() => evaluate<boolean>("window.klaus.traeAuth.status().then(status => status.loggedIn === true && status.needsLogin !== true)"), 90_000, 'the account connects through the real host');
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('trae-auth-logout-btn')) && !document.getElementById('trae-auth-login-btn') && !document.getElementById('trae-auth-import-btn')"), 30_000, 'the connected account retains sign-out without login or import');
      assertEqual(await evaluate<number>("document.getElementById('trae-auth-card')?.querySelectorAll('button').length ?? -1"), 1, 'the connected account card retains only sign-out');
      const state = await evaluate<{ connected: boolean; source: string; models: number; unavailable: number }>(`(async () => {
        const status = await window.klaus.traeAuth.status();
        const saved = await window.klaus.session.getMainModel(undefined, {resolve:false});
        const catalog = await window.klaus.traeAuth.models();
        return { connected:status.loggedIn===true, source:saved.source, models:catalog.models.length,
          unavailable:catalog.models.filter(row=>row.disabled===true || row.unavailable===true).length };
      })()`);
      assertEqual(state.connected, true, 'the engine owns the adopted account');
      assertEqual(state.source, 'trae', 'the model-source preference follows successful adoption');
      assert(state.models > 0, 'the account has a concrete service catalog');
      assert(state.models > 0, 'service-declared models remain present regardless of entitlement');
      const efforts = await evaluate<string[]>(`(async () => {
        const catalog = await window.klaus.traeAuth.models();
        return catalog.models.flatMap(row => (row.traeVariants || []).map(member => member.nativeEffort));
      })()`);
      assert(efforts.includes('light') && efforts.includes('high'), 'the real catalog preserves both declared native efforts');
      writeFileSync(join(root, 'trae-connected.png'), (await desktop.window.webContents.capturePage()).toPNG());
    });

    await h.test('the real renderer bridge exposes quota and independent image/search availability', async () => {
      const state = await evaluate<{ mode: string; windows: number; credits: boolean; image: boolean; video: boolean; search: boolean; speech: boolean }>(`(async () => {
        const usage = await window.klaus.usage.subscriptions();
        const images = await window.klaus.settings.imageSelection.get();
        const search = await window.klaus.settings.webSearchSources.get();
        const videos = await window.klaus.settings.videoSelection.get();
        const speech = await window.klaus.voice.config(undefined, true);
        return { mode:usage.snapshot.mode, windows:(usage.snapshot.provider.windows||[]).length, credits:!!usage.snapshot.provider.credits,
          image:images.availability.trae===true, video:videos.availability.trae===true, search:search.availability?.trae===true, speech:speech.availability?.trae===true };
      })()`);
      assertEqual(state.mode, 'trae', 'quota reads the chosen source');
      assert(state.windows > 0 || state.credits, 'the quota display has real service-reported allowance');
      assertEqual(state.image, true, 'the image backend uses declared source capabilities');
      assertEqual(state.search, true, 'the search backend uses declared source capabilities');
      assertEqual(state.video, true, 'the video backend retains its independent account identity');
      assertEqual(state.speech, true, 'dictation uses its independently selected account source');
    });

    await h.test('disconnect through the account card leaves both recovery actions available', async () => {
      await evaluate("document.getElementById('trae-auth-logout-btn').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('.klaus-dialog-overlay.active .klaus-dialog-confirm'))"), 10_000, 'disconnect asks for confirmation');
      await evaluate("document.querySelector('.klaus-dialog-overlay.active .klaus-dialog-confirm').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('trae-auth-login-btn')) && Boolean(document.getElementById('trae-auth-import-btn'))"), 30_000, 'disconnect restores both account recovery actions');
      await waitFor(() => evaluate<boolean>("window.klaus.traeAuth.status().then(status => status.loggedIn === false)"), 30_000, 'the isolated account disconnects');
      const status = await evaluate<{ loggedIn: boolean }>('window.klaus.traeAuth.status()');
      assertEqual(status.loggedIn, false, 'no stale connected status survives logout');
      await evaluate("window.openSettings('models'); true");
      await waitFor(() => evaluate<boolean>('Boolean(document.querySelector(\'[data-source-tab="trae"]\'))'), 30_000, 'the source tab remains available');
      await evaluate('document.querySelector(\'[data-source-tab="trae"]\').click(); true');
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('trae-auth-login-btn')) && Boolean(document.getElementById('trae-auth-import-btn'))"), 30_000, 'both account recovery actions remain visible');
    });
  } catch (error) {
    startupFailed = true;
    console.error(error instanceof Error ? error.stack : String(error));
  } finally {
    try { await runtime?.shutdown(); } catch { startupFailed = true; }
    const code = await h.finish(join(root, 'trae-ui-result.json'), 'trae-ui');
    app.exit(startupFailed || code !== 0 ? 1 : 0);
  }
})();
