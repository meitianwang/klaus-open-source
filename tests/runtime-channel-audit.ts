import { app } from 'electron';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { registerAppScheme } from '../main/app/protocol';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { kvSet } from '../main/services/settings';
import { currentDesktopEdition } from '../main/services/desktop-edition';
import { claimDesktopProfileEdition } from '../main/services/desktop-profile';
import { waitFor } from './harness';
import { pushEventName, pushPayload } from '../main/ipc/push';
import { assertBrowserSettingsRuntime } from './browser-settings-runtime';
import { assertBrowserDataRuntime, seedBrowserImportFixture } from './browser-data-runtime';

const root = process.env.KLAUS_CHANNEL_AUDIT_PROFILE;
if (!root) throw new Error('Use scripts/audit-runtime-channels.mjs');
process.env.KLAUS_CONFIG_DIR = root;
process.env.CANONICAL_CWD = root;
process.env.KLAUS_TEST = '1';
claimDesktopProfileEdition(root, currentDesktopEdition());
app.setPath('userData', join(root, 'electron'));
registerAppScheme();
app.on('window-all-closed', () => {});

void (async () => {
  let runtime: DesktopRuntime | undefined, code = 1;
  try {
    await app.whenReady();
    for (const key of ['global_shortcut', 'quick_input_shortcut']) kvSet(key, 'off', root);
    writeFileSync(join(root!, 'klaus-guest-mode'), '1', { mode: 0o600 });
    const browserSource = seedBrowserImportFixture(root!);
    const credentialFixtureKey = randomBytes(32);
    const browserSecretCipher = { available: () => true,
      encrypt: (value: string) => { const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',credentialFixtureKey,iv);const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]); },
      decrypt: (value: Buffer) => { const decipher=createDecipheriv('aes-256-gcm',credentialFixtureKey,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8'); },
    };
    runtime = await createDesktopRuntime(app, { show: false, tray: false, externalImportHome: root,
      browserSecretCipher,
      browserImportRoots: [{ id: 'synthetic', label: 'Synthetic browser', userDataDir: browserSource, family: 'chromium' }],
      engineFixtureBinary: process.env.KLAUS_CHANNEL_AUDIT_ENGINE_BINARY });
    const window = runtime.window;
    await waitFor(() => window.webContents.executeJavaScript(`(() => {
      const boot = document.getElementById('boot-screen');
      return Boolean(window.klaus && window.__KLAUS_DESKTOP__ && typeof window.updateSessionInList === 'function'
        && boot && getComputedStyle(boot).display === 'none');
    })()`), 15_000, 'the actual frontend completed its startup channel calls');
    const edition = currentDesktopEdition();
    const distribution = await window.webContents.executeJavaScript('window.klaus.app.distribution()');
    assert.equal(distribution.edition, edition.id);
    assert.equal(distribution.application, edition.application);
    assert.equal(distribution.productName, edition.productName);
    assert.equal(distribution.siteUrl, edition.serverUrl);
    assert.equal(distribution.serverUrl, edition.serverUrl);
    const windowTitle = window.getTitle();
    assert.equal(windowTitle, edition.productName);
    const language = await window.webContents.executeJavaScript('window.currentLang');
    if (edition.defaultLanguage !== null) assert.equal(language, edition.defaultLanguage);
    const profileActivity = await window.webContents.executeJavaScript('window.klaus.profile.activity()');
    assert.deepEqual(profileActivity, { days: [], totalTokens: 0, peakDailyTokens: 0, longestTaskMs: 0, longestStreakDays: 0, currentStreakDays: 0 });
    await window.webContents.executeJavaScript('document.getElementById("sidebar-profile").click()');
    await waitFor(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('#settings-view.active #settings-content dl[aria-busy="false"]') && document.querySelectorAll('#settings-content dd').length === 5 && document.querySelector('#settings-content button:not(:disabled)'))`), 10_000, 'the sidebar settings profile entry renders real engine measurements');
    await window.webContents.executeJavaScript('document.querySelector("#settings-content > div > div:first-child > button:not(:disabled)").click()');
    await waitFor(() => window.webContents.executeJavaScript('Boolean(document.querySelector(\'[role="dialog"] input[name="displayName"]\'))'), 5000, 'the profile editor opens from the live page');
    await window.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))');
    await waitFor(() => window.webContents.executeJavaScript('!document.querySelector(\'[role="dialog"] input[name="displayName"]\')'), 5000, 'the profile editor closes with Escape');
    await window.webContents.executeJavaScript('window.openSettings("profile")');
    await waitFor(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('#settings-content dl[aria-busy="false"]') && document.querySelectorAll('#settings-content dd').length === 5 && document.querySelectorAll('#settings-content button[data-cell]').length === 364 && Boolean(document.querySelector('#settings-content > div > div:first-child > button:not(:disabled)')))`), 10_000, 'the settings profile entry renders real measurements and activity');
    assert.equal(await window.webContents.executeJavaScript('Boolean(document.getElementById("profile-name-input"))'), false);
    await window.webContents.executeJavaScript('window.__auditProfileContent = document.getElementById("settings-content"); window.__auditProfileRemounts = 0; document.querySelector("#settings-content > div > div:first-child > button:not(:disabled)").click()');
    await waitFor(() => window.webContents.executeJavaScript(`(() => {
      if (document.querySelector('[role="dialog"] input[name="displayName"]')) return true;
      const current = document.getElementById('settings-content');
      // A pending preference refresh may replace the page after the initial click.
      if (current !== window.__auditProfileContent && window.__auditProfileRemounts === 0) {
        const button = current?.querySelector('div > div:first-child > button:not(:disabled)');
        if (button) {
          window.__auditProfileContent = current;
          window.__auditProfileRemounts++;
          button.click();
        }
      }
      return false;
    })()`), 5000, 'the settings profile editor opens');
    console.log('Profile editor page replacements:', await window.webContents.executeJavaScript('window.__auditProfileRemounts'));
    await window.webContents.executeJavaScript('window.closeSettings()');
    await waitFor(() => window.webContents.executeJavaScript('!document.querySelector(\'[role="dialog"] input[name="displayName"]\')'), 5000, 'closing settings unmounts the profile editor');
    console.log('Profile runtime integration: aggregate, sidebar and settings entries, five measurements, activity and editor passed');
    await window.webContents.executeJavaScript('window.openSettings("runtime")');
    await waitFor(() => window.webContents.executeJavaScript('Boolean(document.querySelector("#runtime-subagent-model-catalog:not(:disabled)"))'),
      10_000, 'runtime model selection policy loads through the real host bridge');
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("runtime-subagent-model-catalog").checked'), false);
    const clickModelPolicy = async () => {
      const point = await window.webContents.executeJavaScript(`(() => {
        const label = document.querySelector('label:has(#runtime-subagent-model-catalog)');
        label.scrollIntoView({ block: 'center' });
        const rect = label.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    };
    await clickModelPolicy();
    await waitFor(() => window.webContents.executeJavaScript('Boolean(document.querySelector("#runtime-subagent-model-catalog:checked:not(:disabled)"))'),
      10_000, 'catalog selection saves through the actual config facade');
    assert.equal(await window.webContents.executeJavaScript('(async () => (await window.settingsApi.runtimeConfig.get({ kind: "user" })).effective["klaus.subagentModelCatalog"])()'), 'on');
    await window.webContents.executeJavaScript('window.closeSettings(); window.openSettings("runtime")');
    await waitFor(() => window.webContents.executeJavaScript('Boolean(document.querySelector("#runtime-subagent-model-catalog:checked:not(:disabled)"))'),
      10_000, 'reopening the actual settings page restores catalog selection');
    const runtimeLogs = join(__dirname, '../runtime-settings-logs'); mkdirSync(runtimeLogs, { recursive: true });
    writeFileSync(join(runtimeLogs, 'runtime-subagent-model-catalog-live.png'), (await window.webContents.capturePage()).toPNG());
    await clickModelPolicy();
    await waitFor(() => window.webContents.executeJavaScript('Boolean(document.querySelector("#runtime-subagent-model-catalog:not(:checked):not(:disabled)"))'),
      10_000, 'tier-only selection saves through the actual config facade');
    assert.equal(await window.webContents.executeJavaScript('(async () => (await window.settingsApi.runtimeConfig.get({ kind: "user" })).effective["klaus.subagentModelCatalog"])()'), 'off');
    console.log('Subagent model settings integration: default off, catalog on, remount persistence and tier-only reset passed');
    await window.webContents.executeJavaScript('window.openSettings("storage")');
    await waitFor(() => window.webContents.executeJavaScript('Boolean(document.querySelector("#storage-review-button:not(:disabled)"))'), 10_000, 'storage categories finish through the real host bridge');
    const usage = await window.webContents.executeJavaScript('window.klaus.storage.usage()');
    assert.equal(usage.usage.home, root);
    assert.deepEqual(usage.usage.categories.map((entry: { category: string }) => entry.category), ['threads', 'subagents', 'archived', 'worktrees', 'other']);
    const reviewPoint = await window.webContents.executeJavaScript('(() => { const rect = document.getElementById("storage-review-button").getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()');
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...reviewPoint });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...reviewPoint });
    await waitFor(() => window.webContents.executeJavaScript('Boolean(document.querySelector("dialog:modal #storage-review-days"))'), 5000, 'old chat review opens above the real settings layer');
    const storageLogs = join(__dirname, '../storage-settings-logs'); mkdirSync(storageLogs, { recursive: true });
    writeFileSync(join(storageLogs, 'runtime-review.png'), (await window.webContents.capturePage()).toPNG());
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor(() => window.webContents.executeJavaScript('Boolean(!document.querySelector("dialog:modal") && document.querySelector("#settings-view.active"))'), 5000, 'review Escape preserves settings');
    // Seed only the visible ID, then exercise the real preload notification path.
    await window.webContents.executeJavaScript('window.__storageObserved = []; window.klaus.storage.onChanged(event => window.__storageObserved.push(event)); window.__storagePaneBefore = document.getElementById("settings-content"); window.currentSessionId = "00000000-0000-4000-8000-000000000007"');
    window.webContents.send(pushEventName('storage:chats-changed'), pushPayload({ kind: 'deleted', sessionIds: ['00000000-0000-4000-8000-000000000007'] }));
    await waitFor(() => window.webContents.executeJavaScript('window.currentSessionId === null && Boolean(document.querySelector("#settings-view.active")) && document.getElementById("settings-content") === window.__storagePaneBefore'), 5000, 'storage notification retires the visible ID without remounting settings');
    assert.equal(await window.webContents.executeJavaScript('document.activeElement?.id'), 'storage-review-button');
    await window.webContents.executeJavaScript('document.getElementById("storage-manage-worktrees").click()');
    await waitFor(() => window.webContents.executeJavaScript('Boolean(document.getElementById("worktrees-root") && document.getElementById("worktrees-upstream") && document.getElementById("worktrees-auto-cleanup") && document.getElementById("worktrees-keep-count"))'), 5000, 'worktree settings load actual storage policy');
    assert.equal(await window.webContents.executeJavaScript('window.currentSettingsTab === "worktrees" && !document.querySelector("dialog:modal") && Boolean(document.querySelector(\'[data-stab="worktrees"][aria-current="page"] svg\'))'), true);
    await window.webContents.executeJavaScript('window.openSettings("storage"); document.getElementById("storage-manage-archived").click()');
    await waitFor(() => window.webContents.executeJavaScript('window.currentSettingsTab === "archivedSessions" && !document.querySelector("dialog:modal")'), 5000, 'archive management uses the existing settings page');
    await window.webContents.executeJavaScript('window.closeSettings()');
    console.log('Storage runtime integration: measurements, native review, worktree policy and archived navigation passed');
    await assertBrowserSettingsRuntime(runtime, root!);
    await assertBrowserDataRuntime(runtime);
    const registered = runtime.registry.channels();
    await runtime.shutdown();
    const result = { registered, distribution, language, windowTitle, engineAfterShutdown: runtime.engine.liveProcessCount(), nativeAfterShutdown: runtime.nativeCounts() };
    console.log(JSON.stringify({ audit: 'desktop-distribution-startup', edition: edition.id, productName: distribution.productName, language, windowTitle }));
    writeFileSync(join(root!, 'registry.json'), JSON.stringify(result));
    code = 0;
  } catch (error) {
    console.error(error);
    try {
      if (runtime && !runtime.window.isDestroyed()) console.error('Runtime renderer state:', await runtime.window.webContents.executeJavaScript('({ current: window.currentSessionId, settings: Boolean(document.querySelector("#settings-view.active")), paneMatches: document.getElementById("settings-content") === window.__storagePaneBefore, tab: window.currentSettingsTab, focus: document.activeElement?.id, observed: window.__storageObserved, dialogCount: document.querySelectorAll("dialog:modal").length })'));
    } catch (diagnosticError) { console.error('Renderer diagnostic failed', diagnosticError); }
    for (const name of readdirSync(root!)) if (name.endsWith('.log')) console.error(`Runtime diagnostic ${name}:\n${readFileSync(join(root!, name), 'utf8')}`);
  }
  finally {
    try { await runtime?.shutdown(); } catch (error) { console.error(error); code = 1; }
    app.exit(code);
  }
})();
