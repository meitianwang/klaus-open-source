import { app } from 'electron';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { registerAppScheme } from '../main/app/protocol';
import { kvSet } from '../main/services/settings';
import { Harness, assert, assertEqual, waitFor } from './harness';

const root = process.env.KLAUS_KIRO_UI_PROFILE;
const evidence = process.env.KLAUS_KIRO_UI_LOG_DIR;
if (!root || !evidence) throw new Error('An isolated Kiro UI profile and evidence directory are required.');
process.env.KLAUS_CONFIG_DIR = root;
process.env.KLAUS_TEST = '1';
const home = join(root, 'external-home'), tokenPath = join(home, '.aws/sso/cache/kiro-auth-token.json');
process.env.KLAUS_KIRO_LOCAL_HOME = home;
mkdirSync(join(root, 'electron'), { recursive: true });
mkdirSync(join(home, '.aws/sso/cache'), { recursive: true });
const external = JSON.stringify({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), authMethod: 'social', provider: 'Google', profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture' });
writeFileSync(tokenPath, external, { mode: 0o600 });
app.setPath('userData', join(root, 'electron'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
registerAppScheme();
app.on('window-all-closed', () => {});
const h = new Harness();
const backend = createServer((request, response) => {
  const path = new URL(request.url || '/', 'http://localhost').pathname;
  response.setHeader('content-type', 'application/json');
  if (path === '/List-Available-Models') response.end(JSON.stringify({ defaultModel: { modelId: 'auto' }, models: [{ modelId: 'auto', modelName: 'Auto' }, { modelId: 'fixture-chat', modelName: 'Fixture Chat', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 }, additionalModelRequestFieldsSchema: { properties: { reasoning: { properties: { effort: { enum: ['none', 'high', 'max'], default: 'high' } } } } } }] }));
  else if (path === '/Get-Usage-Limits') response.end(JSON.stringify({ nextDateReset: 1793491200, subscriptionInfo: { subscriptionTitle: 'KIRO FREE' }, usageBreakdownList: [{ resourceType: 'CREDIT', currentUsageWithPrecision: 2.28, usageLimitWithPrecision: 50, freeTrialInfo: { freeTrialStatus: 'EXPIRED', usageLimitWithPrecision: 500 } }], overageConfiguration: { overageStatus: 'DISABLED' } }));
  else if (path === '/mcp') {
    let body = '';
    request.on('data', value => { body += value; });
    request.on('end', () => {
      const input = JSON.parse(body);
      response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, error: null, result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ title: 'Rust documentation', url: 'https://doc.rust-lang.org/', snippet: 'Fixture search result.' }] }) }] } }));
    });
  } else { response.statusCode = 404; response.end('{}'); }
});

void (async () => {
  let runtime: DesktopRuntime | undefined, failed = false;
  try {
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
    const address = backend.address();
    if (!address || typeof address === 'string') throw new Error('The fixture backend did not start.');
    process.env.KLAUS_KIRO_MANAGEMENT_URL = `http://127.0.0.1:${address.port}`;
    process.env.KLAUS_KIRO_RUNTIME_URL = process.env.KLAUS_KIRO_MANAGEMENT_URL;
    await app.whenReady();
    writeFileSync(join(root, 'klaus-guest-mode'), '1', { mode: 0o600 });
    for (const [key, value] of Object.entries({ auth_mode: 'custom', global_shortcut: 'off', quick_input_shortcut: 'off', 'notification.desktop': 'off', 'notification.sound': 'off', 'mobile_bridge.enabled': '0', 'external_agent_import.onboarding_dismissed': '1' })) kvSet(key, value, root);
    runtime = await createDesktopRuntime(app, { show: false, tray: false, externalAuthHomeDir: home });
    const desktop = runtime;
    desktop.window.webContents.on('console-message', event => {
      appendFileSync(join(evidence, 'kiro-ui-renderer.log'), `${event.level}: ${event.message}\n`);
    });
    const evaluate = <T>(code: string): Promise<T> => desktop.window.webContents.executeJavaScript(code) as Promise<T>;
    await waitFor(() => evaluate<boolean>('Boolean(window.klaus && window.__KLAUS_DESKTOP__)'), 30_000, 'the bridge loads');
    await waitFor(() => evaluate<boolean>("!document.getElementById('boot-screen') || getComputedStyle(document.getElementById('boot-screen')).display === 'none'"), 30_000, 'the application finishes startup');
    await waitFor(() => evaluate<boolean>("typeof window.openSettings === 'function'"), 30_000, 'the settings entry point loads');
    desktop.show(); desktop.window.setContentSize(1280, 900);

    await h.test('the Kiro account card exposes direct browser login and local reuse', async () => {
      await evaluate("window.openSettings('models'); true");
      await waitFor(() => evaluate<boolean>('Boolean(document.querySelector(\'[data-source-tab="kiro"]\'))'), 30_000, 'the Kiro source appears');
      await evaluate('document.querySelector(\'[data-source-tab="kiro"]\').click(); true');
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('kiro-auth-login-btn')) && Boolean(document.getElementById('kiro-auth-import-btn'))"), 30_000, 'both account actions appear');
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      assertEqual(await evaluate<number>("document.getElementById('kiro-auth-card')?.querySelectorAll('button').length ?? -1"), 2, 'the signed-out card has exactly two buttons');
      writeFileSync(join(evidence, 'kiro-signed-out.png'), (await desktop.window.webContents.capturePage()).toPNG());
    });

    await h.test('local reuse follows the real host and engine facade and preserves its external grant', async () => {
      await evaluate("document.getElementById('kiro-auth-import-btn').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('.klaus-dialog-overlay.active .klaus-dialog-confirm'))"), 10_000, 'the account reuse dialog appears');
      await evaluate("document.querySelector('.klaus-dialog-overlay.active .klaus-dialog-confirm').click(); true");
      await waitFor(() => evaluate<boolean>('window.klaus.kiroAuth.status().then(state => state.loggedIn === true && state.needsLogin !== true)'), 30_000, 'the fixture account connects through the engine');
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('kiro-auth-logout-btn')) && !document.getElementById('kiro-auth-login-btn') && !document.getElementById('kiro-auth-import-btn')"), 30_000, 'the connected account retains sign-out without login or import');
      assertEqual(await evaluate<number>("document.getElementById('kiro-auth-card')?.querySelectorAll('button').length ?? -1"), 1, 'the connected account card retains only sign-out');
      assertEqual(readFileSync(tokenPath, 'utf8'), external, 'the imported external grant remains unchanged');
      const state = await evaluate<any>(`(async () => ({ source: (await window.klaus.session.getMainModel(undefined, {resolve:false})).source, catalog: await window.klaus.kiroAuth.models(), usage: await window.klaus.usage.subscriptions(), search: await window.klaus.settings.webSearchSources.get() }))()`);
      assertEqual(state.source, 'kiro', 'the source activates only after adoption');
      assertEqual(state.catalog.models.filter((row: { key: string }) => row.key === 'fixture-chat').length, 1, 'the account catalog retains one row for the declared family');
      assertEqual(state.catalog.models.some((row: { key: string }) => row.key === 'auto'), false, 'the service routing entry is excluded');
      assertEqual(state.usage.snapshot.provider.windows[0].remaining, 47.72, 'decimal allowance survives the real host projection');
      assertEqual(state.search.availability?.kiro, true, 'independent native search uses the connected Kiro account');
      await evaluate('window.klaus.session.setThinkingLevel("none", undefined, {ultraMode:false})');
      const native = await evaluate<any>('(async () => ({model:await window.klaus.session.getMainModel(undefined,{resolve:false}),thinking:await window.klaus.session.getThinkingLevel()}))()');
      assertEqual(native.model.mode, 'kiro:fixture-chat::effort=none', 'native effort retains its exact model member through the bridge');
      assertEqual(native.thinking.level, 'none', 'the service-native none value survives persistence');
      writeFileSync(join(evidence, 'kiro-native-selection.json'), JSON.stringify(native, null, 2));
      writeFileSync(join(evidence, 'kiro-connected.png'), (await desktop.window.webContents.capturePage()).toPNG());
      writeFileSync(join(evidence, 'kiro-ui-projection.json'), JSON.stringify(state, null, 2));
    });

    await h.test('the selected source button and source menu both show the official Kiro mark', async () => {
      await evaluate('window.closeSettings(); true');
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('auth-mode-pill')?.querySelector('img[src=\"kiro-logo.png\"]'))"), 10_000, 'the current source logo updates');
      await evaluate("document.getElementById('auth-mode-pill').click(); true");
      await waitFor(() => evaluate<boolean>('Boolean(document.querySelector(\'[data-auth-mode-choice="kiro"] img\'))'), 10_000, 'the Kiro menu row opens');
      const mark = await evaluate<string>('document.querySelector(\'[data-auth-mode-choice="kiro"] img\')?.getAttribute("src") || ""');
      assert(mark.includes('kiro-logo.png'), 'the source menu has the Kiro logo');
      writeFileSync(join(evidence, 'kiro-source-menu.png'), (await desktop.window.webContents.capturePage()).toPNG());
      await evaluate('document.querySelector(\'[data-auth-mode-choice="kiro"]\').click(); true');
    });

    await h.test('the real chat model menu excludes service routing aliases', async () => {
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('#main-model-select .kls-select-trigger:not(:disabled)'))"), 10_000, 'the model picker becomes ready');
      await evaluate("document.querySelector('#main-model-select .kls-select-trigger').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('#main-model-select .kls-select-panel:not([hidden]) .kls-select-item'))"), 10_000, 'the concrete model menu opens');
      const labels = await evaluate<string[]>("Array.from(document.querySelectorAll('#main-model-select .kls-select-panel:not([hidden]) .kls-select-item')).map(row => row.textContent.trim())");
      assert(labels.some(label => label.includes('Fixture Chat')), 'the concrete family remains visible');
      assert(!labels.some(label => /^auto$/i.test(label)), 'no provider Auto row is rendered');
      const identities = await evaluate<string[]>("Array.from(document.querySelectorAll('#main-model-select [data-model-value]')).map(row => row.getAttribute('data-model-value') || '')");
      assertEqual(identities.length, 1, 'only the native fixture catalog member appears');
      assertEqual(identities[0]?.split('::effort=')[0], 'kiro:fixture-chat', 'the menu does not synthesize other model identities');
      writeFileSync(join(evidence, 'kiro-concrete-model-labels.json'), JSON.stringify(labels, null, 2));
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      writeFileSync(join(evidence, 'kiro-concrete-model-menu.png'), (await desktop.window.webContents.capturePage()).toPNG());
      await evaluate("document.querySelector('#main-model-select .kls-select-trigger').click(); true");
    });

    await h.test('capability settings expose and persist Kiro search independently of the chat model', async () => {
      await evaluate("window.openSettings('engineWeb'); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('#klaus-ws-source .kls-select-trigger:not(:disabled)'))"), 20_000, 'the independent search source picker loads');
      await evaluate("document.querySelector('#klaus-ws-source .kls-select-trigger').click(); true");
      await waitFor(() => evaluate<boolean>("Array.from(document.querySelectorAll('#klaus-ws-source .kls-select-item')).some(row => row.textContent.trim() === 'Kiro')"), 10_000, 'Kiro is a search source choice');
      const labels = await evaluate<string[]>("Array.from(document.querySelectorAll('#klaus-ws-source .kls-select-item')).map(row => row.textContent.trim())");
      writeFileSync(join(evidence, 'kiro-search-source-labels.json'), JSON.stringify(labels, null, 2));
      await evaluate("document.getElementById('klaus-ws-source').scrollIntoView({block:'center'}); true");
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      writeFileSync(join(evidence, 'kiro-search-source-options.png'), (await desktop.window.webContents.capturePage()).toPNG());
      await evaluate("Array.from(document.querySelectorAll('#klaus-ws-source .kls-select-item')).find(row => row.textContent.trim() === 'Kiro').click(); true");
      await waitFor(() => evaluate<boolean>("window.klaus.settings.kv.get('klaus.webSearch.source').then(value => value === 'kiro')"), 10_000, 'the independent search selection persists immediately');
      const persisted = await evaluate<any>("(async () => ({search:await window.klaus.settings.kv.get('klaus.webSearch.source'),model:await window.klaus.session.getMainModel(undefined,{resolve:false})}))()");
      assertEqual(persisted.model.source, 'kiro', 'selecting search preserves the chat source');
      assertEqual(persisted.model.mode, 'kiro:fixture-chat::effort=none', 'selecting search preserves the exact chat member');
      writeFileSync(join(evidence, 'kiro-search-preference.json'), JSON.stringify(persisted, null, 2));
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      writeFileSync(join(evidence, 'kiro-search-source-selected.png'), (await desktop.window.webContents.capturePage()).toPNG());
      await evaluate('window.closeSettings(); true');
    });

    await h.test('disconnect through the account card preserves the external grant', async () => {
      await evaluate("window.openSettings('models'); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('[data-source-tab=\"kiro\"]'))"), 30_000, 'the source tab remains available');
      await evaluate("document.querySelector('[data-source-tab=\"kiro\"]').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('kiro-auth-logout-btn'))"), 30_000, 'the connected account appears');
      await evaluate("document.getElementById('kiro-auth-logout-btn').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('.klaus-dialog-overlay.active .klaus-dialog-confirm'))"), 10_000, 'disconnect asks for confirmation');
      await evaluate("document.querySelector('.klaus-dialog-overlay.active .klaus-dialog-confirm').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('kiro-auth-login-btn')) && Boolean(document.getElementById('kiro-auth-import-btn'))"), 30_000, 'disconnect restores both account recovery actions');
      assertEqual(await evaluate<boolean>('window.klaus.kiroAuth.status().then(state => state.loggedIn)'), false, 'the source disconnects');
      assertEqual(readFileSync(tokenPath, 'utf8'), external, 'disconnect preserves the external login');
    });
  } catch (error) { failed = true; console.error(error instanceof Error ? error.stack : String(error)); }
  finally {
    try { await runtime?.shutdown(); } catch { failed = true; }
    await new Promise<void>(resolve => backend.close(() => resolve()));
    const code = await h.finish(join(evidence, 'kiro-ui-result.json'), 'kiro-ui');
    app.exit(failed || code !== 0 ? 1 : 0);
  }
})();
