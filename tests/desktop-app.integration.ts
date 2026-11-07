import { app, autoUpdater, BrowserWindow, ipcMain } from 'electron';
import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { registerAppScheme } from '../main/app/protocol';
import { HOST_CHANNELS } from '../main/ipc/binding';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { kvDel, kvGet, kvSet } from '../main/services/settings';
import type { Json } from '../main/ipc/contract';
import { startProvider } from './fixtures/anthropic';
import { PNG_FIXTURE_BASE64, PDF_FIXTURE } from './fixtures/media';
import { STDIO_MCP_FIXTURE } from './fixtures/stdio-mcp';
import { createMcpOAuthFixture } from './mcp-oauth';
import { zip } from './archive-bytes-fixture';
import { createWechatTransportFixture } from './channel-runtime';
import { createDiscordFixture } from './discord-fixture';
import { createWeComFixture } from './wecom-channel';
import { createQQFixture } from './qq-channel';
import { createDingTalkFixture } from './dingtalk-channel';
import { dingtalkAdapter } from '../main/services/channels/dingtalk';
import { deviceFixture } from './mcp-device-fixture';
import { testDeviceDreamApp } from './device-dream-app';
import { testMobileUsageApp } from './mobile-usage-app';
import { testConnectorsApp } from './connectors-app';
import { testAgentsApp } from './agents-app';
import { testNotificationsApp } from './notifications-app';
import { testControlApp } from './control-app';
import { createWhatsAppAppFixture, testWhatsAppApp } from './whatsapp-app';
import type { DesktopNotice } from '../main/services/notifications';
import { createFeishuFixture, FEISHU_FIXTURE_ACCOUNT, feishuFixtureEvent } from './feishu-fixture';
import { feishuAdapter } from '../main/services/channels/feishu';
import { object, type JsonObject } from '../main/services/service-types';
import type { BrowserObject } from '../main/browser/types';
import { wecomAdapter } from '../main/services/channels/wecom';
import { qqAdapter } from '../main/services/channels/qq';
import { testCatalogImportFeedbackApp } from './catalog-import-feedback-app';
import { testComputerUseApp } from './computer-use-app';
import { assert, assertEqual, assertRejects, Harness, waitFor } from './harness';

const root = process.env.KLAUS_DESKTOP_FIXTURE_PROFILE;
if (!root) throw new Error('Run this fixture with scripts/run-app-test.mjs');
process.env.KLAUS_CONFIG_DIR = root;
process.env.KLAUS_TEST = '1';
if (process.platform === 'win32') {
  // The engine tool fixture uses a known shell; the terminal panel still uses cmd.
  process.env.KLAUS_SHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(process.env.KLAUS_SHELL)) throw new Error('The Windows fixture requires the system PowerShell executable');
} else process.env.SHELL = '/bin/sh';
app.setPath('userData', join(root, 'electron'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
registerAppScheme();
app.on('window-all-closed', () => {});
const h = new Harness();
const notificationNotices: DesktopNotice[] = [];
let notificationFocused = false;
const notificationFixture = { show: (notice: DesktopNotice): void => { notificationNotices.push(notice); }, focused: () => notificationFocused };
const externalImportHome = join(root, 'external-import-home');
mkdirSync(externalImportHome, { recursive: true });

void (async () => {
  let runtime: DesktopRuntime | undefined;
  let provider: Awaited<ReturnType<typeof startProvider>> | undefined;
  let sshFixture: ChildProcess | undefined;
  let sshExited: Promise<void> | undefined;
  let mcpOAuth: Awaited<ReturnType<typeof createMcpOAuthFixture>> | undefined;
  let discord: Awaited<ReturnType<typeof createDiscordFixture>> | undefined;
  let wecom: Awaited<ReturnType<typeof createWeComFixture>> | undefined;
  let qq: Awaited<ReturnType<typeof createQQFixture>> | undefined;
  let dingtalk: Awaited<ReturnType<typeof createDingTalkFixture>> | undefined;
  let feishu: Awaited<ReturnType<typeof createFeishuFixture>> | undefined;
  let device: Awaited<ReturnType<typeof deviceFixture>> | undefined;
  let whatsapp: Awaited<ReturnType<typeof createWhatsAppAppFixture>> | undefined;
  try {
    await app.whenReady();
    app.setAccessibilitySupportEnabled(true);
    kvSet('auth_mode', 'custom', root);
    kvSet('composer.main_model', 'custom:fixture', root);
    kvSet('composer.thinking_level', 'off', root);
    kvSet('global_shortcut', 'off', root);
    kvSet('quick_input_shortcut', 'off', root);
    kvSet('notification.desktop', 'off', root);
    kvSet('notification.sound', 'off', root);
    kvSet('mobile_bridge.enabled', '0', root);
    const target = join(root, 'approval-target.txt');
    writeFileSync(target, 'A disposable fixture file.');
    const removeTarget = process.platform === 'win32'
      ? `Remove-Item -LiteralPath '${target.replace(/'/g, "''")}' -Force -ErrorAction Stop`
      : `rm -f '${target.replace(/'/g, "'\\''")}'`;
    provider = await startProvider(removeTarget);
    process.env.KLAUS_SERVER_URL = provider.url;
    writeFileSync(join(root, 'klaus-guest-mode'), '1', { mode: 0o600 });
    await h.test('a failed host constructor releases startup resources before retry', async () => {
      const prior = process.env.KLAUS_LOCAL_LLM_PORT;
      const listeners = ipcMain.listenerCount(HOST_CHANNELS.deliveryAck);
      try {
        process.env.KLAUS_LOCAL_LLM_PORT = 'invalid-port';
        await assertRejects(() => createDesktopRuntime(app, { show: false, tray: false, notificationFixture, nativeFixtureAddonPath: join(process.env.KLAUS_WHATSAPP_FIXTURE_DIR!, `klaus-native-${process.platform}-${process.arch}.node`), externalImportHome }), 'invalid local runtime configuration');
        assertEqual(ipcMain.listenerCount(HOST_CHANNELS.deliveryAck), listeners, 'partially installed IPC listener was removed');
        assertEqual(BrowserWindow.getAllWindows().length, 0, 'failed startup left no window');
      } finally {
        if (prior === undefined) delete process.env.KLAUS_LOCAL_LLM_PORT;
        else process.env.KLAUS_LOCAL_LLM_PORT = prior;
      }
    });
    const sshHome = join(root, 'ssh-user'), sshRoot = join(root, 'ssh-fixture');
    mkdirSync(join(sshHome, '.ssh'), {recursive:true}); mkdirSync(sshRoot);
    assert(process.env.KLAUS_SSH_FIXTURE_BINARY, 'the independent SSH fixture was built');
    sshFixture = spawn(process.env.KLAUS_SSH_FIXTURE_BINARY, [sshRoot], {stdio:['ignore','pipe','pipe'], windowsHide:true});
    sshExited = new Promise(resolve => { sshFixture!.once('close', () => resolve()); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSH fixture startup timed out')), 15000);
      sshFixture!.once('error', error => { clearTimeout(timer); reject(error); });
      sshFixture!.once('exit', () => { clearTimeout(timer); reject(new Error('SSH fixture exited before startup')); });
      sshFixture!.stdout!.on('data', (bytes:Buffer) => { if (bytes.toString().includes('SSH fixture ready')) { clearTimeout(timer); resolve(); } });
      sshFixture!.stderr!.on('data', (bytes:Buffer) => process.stderr.write(bytes));
    });
    const sshPort = (JSON.parse(readFileSync(join(sshRoot, 'fixture.json'), 'utf8')) as {port:number}).port;
    writeFileSync(join(sshHome, '.ssh/config'), `Host gui-fixture
  HostName 127.0.0.1
  User fixture
  Port ${sshPort}
`);
    const exportedPath = join(root, 'conversation-export.txt'), specExportedPath = join(root, 'selected-spec-export.md');
    const pastedPath = join(root, 'copied 文档 with spaces.txt'); writeFileSync(pastedPath, 'Only a disposable copied file.');
    let clipboardReads = 0;
    discord = await createDiscordFixture();
    wecom = await createWeComFixture();
    qq = await createQQFixture();
    dingtalk = await createDingTalkFixture(); device = await deviceFixture();
    feishu = await createFeishuFixture();
    whatsapp = await createWhatsAppAppFixture(process.env.KLAUS_WHATSAPP_FIXTURE_DIR!);
    runtime = await createDesktopRuntime(app, { show: false, tray: false, notificationFixture, nativeFixtureAddonPath: join(process.env.KLAUS_WHATSAPP_FIXTURE_DIR!, `klaus-native-${process.platform}-${process.arch}.node`), whatsappNativeFactory: whatsapp.factory, externalImportHome, mcpDeviceBaseUrl: device.origin, sshIdentity: {userHome:sshHome,localUser:'fixture',agentPath:null},
      discordTransport: { apiBase: discord.apiBase, approvalsIntervalMs: 40, backoffMs: [100] },
      channelTransports: { wecom: wecomAdapter({ wsUrl: wecom.wsUrl, heartbeatIntervalMs: 100, backoffMs: [50] }), qq: qqAdapter({ ...qq, backoffMs: [50] }), dingtalk: dingtalkAdapter({ ...dingtalk, backoffMs: [50] }), feishu: feishuAdapter({ ...feishu, debounceMs: 5, maxBurstMs: 30 }) },
      readClipboardFiles: async () => { clipboardReads++; return [{ types:['text/uri-list'], getType:async()=>new Blob([pathToFileURL(pastedPath).href]) }]; },
      voiceFixture: { micPermission: async () => ({ ok: true, status: 'synthetic-fixture' }),
        speechCommand: { executable: process.execPath, args: [join(__dirname, '../../tests/fixtures/speech-helper.cjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } },
      recordingFixtureCommand: { executable: process.execPath, args: [join(__dirname, '../../tests/fixtures/recording-helper.cjs')],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KLAUS_RECORDING_FIXTURE_TRACE: join(root, 'recording-trace.jsonl') } },
      chooseSessionExportPath: async () => exportedPath, chooseSpecExportPath: async () => specExportedPath, openMcpAuthorizationUrl: async url => {
        assert(mcpOAuth, 'only the isolated OAuth fixture can open a browser'); await mcpOAuth.openExternal(url);
      } });
    let desktop = runtime;
    writeFileSync(join(__dirname, 'registered-channels.json'), JSON.stringify(desktop.registry.channels(), null, 2));
    const engineEvents: unknown[] = [];
    desktop.engine.on('event', event => engineEvents.push(event));
    await desktop.sessions.request('config/batchWrite', { edits: [{ keyPath: 'modelProviders.fixture', mergeStrategy: 'replace', value: {
      name: 'Fixture', provider: 'anthropic', model: 'fixture-model', baseUrl: provider.url,
      maxContextTokens: 200000, default: true, thinking: 'off',
      capabilities: { contextWindow: 200000, vision: true, nativePdf: true },
    } }] });
    await desktop.sessions.request('model/credential/write', { id: 'fixture', apiKey: 'fixture-key' });
    const invoke = (channel: string, value?: Json): Promise<unknown> => desktop.window.webContents.executeJavaScript(
      `window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke', ${JSON.stringify({ channel, args: value === undefined ? [] : [value] })})`,
    );
    await h.test('the actual frontend loads with an isolated preload and no page Node access', async () => {
      await waitFor(() => desktop.window.webContents.executeJavaScript("Boolean(window.klaus && window.__KLAUS_DESKTOP__)"), 15000, 'frontend bridge loaded');
      assertEqual(await desktop.window.webContents.executeJavaScript('typeof window.require'), 'undefined', 'renderer has no Node require');
      assertEqual(await desktop.window.webContents.executeJavaScript('typeof window.process'), 'undefined', 'renderer has no process');
      await assertRejects(() => invoke('not-a-host-capability'), 'unknown channel fails');
    });
    await h.test('every non-model settings page renders without clipping or unnamed controls', async () => {
      const tabs = [
        ['profile', '01-profile'], ['preferences', '02-preferences'], ['voiceInput', '03-voice-input'],
        ['externalImport', '04-external-import'], ['archivedSessions', '05-archived-sessions'],
        ['engineWeb', '06-engine-web'], ['permissions', '08-permissions'],
        ['runtime', '09-runtime'], ['hooks', '10-hooks'], ['engineMemory', '11-engine-memory'],
        ['mobile', '12-mobile'], ['systemAuth', '13-system-auth'],
      ] as const;
      const output = join(__dirname, 'settings-audit-current');
      mkdirSync(output, { recursive: true });
      desktop.window.setContentSize(1280, 820);
      await waitFor(
        () => desktop.window.webContents.executeJavaScript("typeof window.openSettings === 'function' && typeof window.closeSettings === 'function'"),
        10_000,
        'settings shell ready',
      );
      await waitFor(
        () => desktop.window.webContents.executeJavaScript("!document.getElementById('boot-screen') || getComputedStyle(document.getElementById('boot-screen')).display === 'none'"),
        15_000,
        'workbench startup before settings audit',
      );
      const report: Array<Record<string, unknown>> = [];
      for (const [tab, slug] of tabs) {
        await desktop.window.webContents.executeJavaScript(`window.openSettings(${JSON.stringify(tab)}); true`);
        try {
          await waitFor(() => desktop.window.webContents.executeJavaScript(`(() => {
            const content = document.getElementById('settings-content');
            return window.currentSettingsTab === ${JSON.stringify(tab)} && Boolean(content && content.textContent.trim().length > 0);
          })()`), 10_000, `${tab} settings content`);
        } catch (error) {
          const diagnostic = await desktop.window.webContents.executeJavaScript(`(() => ({
            currentSettingsTab: window.currentSettingsTab,
            viewClass: document.getElementById('settings-view')?.className,
            contentHtml: document.getElementById('settings-content')?.innerHTML,
            navCount: document.querySelectorAll('[data-stab]').length,
            active: Array.from(document.querySelectorAll('[data-stab].active')).map(element => element.getAttribute('data-stab')),
            loaders: {profile: typeof window.loadProfileTab, settings: typeof window.openSettings},
          }))()`);
          throw new Error(`${String(error)}; state=${JSON.stringify(diagnostic).slice(0, 4000)}`);
        }
        // Settings APIs are local, but several pages replace their initial loading
        // frame after the first IPC round trip. Inspect the settled controls rather
        // than declaring the header-only frame accessible.
        await waitFor(() => desktop.window.webContents.executeJavaScript(`(() => {
          const root = document.getElementById('settings-content');
          return Boolean(root?.querySelector('button, input, select, textarea'));
        })()`), 10_000, `${tab} settings controls`);
        const state = await desktop.window.webContents.executeJavaScript(`(() => {
          const visible = element => {
            const style = getComputedStyle(element), rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const root = document.getElementById('settings-content');
          const controls = Array.from(root.querySelectorAll('button, input, select, textarea')).filter(visible);
          const rows = controls.map(element => {
            const id = element.id;
            const explicit = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]')?.textContent?.trim() : '';
            const wrapping = element.closest('label')?.textContent?.trim();
            return {
              tag: element.tagName.toLowerCase(), type: element.getAttribute('type'),
              name: element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || explicit || wrapping || element.textContent?.trim() || '',
              disabled: element.disabled === true,
            };
          });
          const main = document.querySelector('.settings-main');
          const sidebar = document.querySelector('.settings-sidebar');
          return {
            tab: window.currentSettingsTab,
            activeLabel: document.querySelector('[data-stab].active')?.textContent?.trim() || '',
            title: root.querySelector('h1')?.textContent?.trim() || '',
            controls: rows.length,
            unlabeled: rows.filter(row => !row.name && row.type !== 'hidden'),
            main: {clientWidth: main.clientWidth, scrollWidth: main.scrollWidth, clientHeight: main.clientHeight},
            sidebar: {clientWidth: sidebar.clientWidth, clientHeight: sidebar.clientHeight},
            text: root.innerText.slice(0, 4000),
          };
        })()`) as {tab:string;activeLabel:string;title:string;controls:number;unlabeled:unknown[];main:{clientWidth:number;scrollWidth:number;clientHeight:number};sidebar:{clientWidth:number;clientHeight:number};text:string};
        assertEqual(state.tab, tab, `${tab} is the active settings route`);
        assert(state.activeLabel.length > 0 && state.title.length > 0, `${tab} exposes its navigation label and page title`);
        assertEqual(state.unlabeled.length, 0, `${tab} has no visible unnamed form controls`);
        assert(state.main.scrollWidth <= state.main.clientWidth + 1, `${tab} does not clip horizontally`);
        assert(state.sidebar.clientWidth > 0 && state.sidebar.clientHeight > 0 && state.main.clientHeight > 0, `${tab} retains the settings shell geometry`);
        const image = await desktop.window.webContents.capturePage(undefined, { stayHidden: true });
        assert(!image.isEmpty(), `${tab} paints a non-empty settings frame`);
        writeFileSync(join(output, `${slug}.png`), image.toPNG());
        report.push(state);
      }
      writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      await desktop.window.webContents.executeJavaScript('window.closeSettings(); true');
      assertEqual(report.length, 13, 'the audit covers every non-model settings page');
    });
    await testAgentsApp(h, desktop, invoke, root);
    await testNotificationsApp(h, desktop, invoke, root, { notices: notificationNotices, focus: value => { notificationFocused = value; } });
    await testCatalogImportFeedbackApp(h, desktop, invoke, root, externalImportHome);
    await testDeviceDreamApp(h, desktop, invoke, root, device);
    await testMobileUsageApp(h, desktop, invoke);
    await testWhatsAppApp(h, desktop, invoke, root, whatsapp!);
    await testConnectorsApp(h, desktop, invoke, root);
    await h.test('Feishu gateway messages produce a real shared-engine reply with an actual vendor receipt', async () => {
      const fixture = feishu!; let id: string | undefined;
      try {
        assertEqual(object(await invoke('channels:connect', { id: 'feishu', config: FEISHU_FIXTURE_ACCOUNT })).ok, true, 'actual token, bot and WebSocket handshake completed');
        fixture.send(feishuFixtureEvent('om_gui', { content: '{"text":"FEISHU GUI REAL ENGINE FIXTURE"}', create_time: String(Date.now()) }), 'wire-gui');
        await waitFor(() => fixture.replies().some(call => JSON.stringify(call.body).includes('Fixture response complete.')), 20_000, 'the real model reply reached the Feishu REST fixture');
        assert(fixture.acks().some(row => row.frame.payload?.toString().includes('200')), 'the originating gateway frame was acknowledged');
        const row = await desktop.sessions.channelThread('feishu:ou_sender'); assert(typeof row?.id === 'string', 'the incoming author has one persisted thread'); id = row.id;
        assert(JSON.stringify(await invoke('session:history', { sessionId: id })).includes('FEISHU GUI REAL ENGINE FIXTURE'), 'the Feishu user message is in real engine history');
        assertEqual(desktop.engine.liveProcessCount(), 1, 'Feishu does not create a second engine owner');
      } finally { await invoke('channels:disconnect', { id: 'feishu' }); if (id) await invoke('session:delete', { sessionId: id }); }
    });
    await h.test('the real skill upload bridge and ZIP acquisition preserve content in the shared skill catalog', async () => {
      const uploaded = '---\nname: gui-upload\ndescription: An isolated upload fixture.\n---\nOnly this fixture.\n';
      const downloaded = '---\nname: gui-zip\ndescription: An isolated ZIP fixture.\n---\nOnly this downloaded fixture.\n';
      const bytes = zip([{ name: 'SKILL.md', bytes: Buffer.from(downloaded) }]);
      const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/zip' }); response.end(bytes); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); assert(address && typeof address === 'object', 'isolated archive endpoint');
      try {
        const upload = await desktop.window.webContents.executeJavaScript(`window.klaus.skills.upload('gui-upload.md', new TextEncoder().encode(${JSON.stringify(uploaded)}).buffer)`) as { ok: boolean; name: string };
        assert(upload.ok && upload.name === 'gui-upload', 'actual ArrayBuffer bridge reaches the upload service');
        assertEqual(readFileSync(join(root, 'skills/gui-upload/SKILL.md'), 'utf8'), uploaded, 'uploaded bytes retained');
        const installed = await invoke('skills:install-from-source', { spec: `http://127.0.0.1:${address.port}/gui-zip.zip`, name: 'gui-zip' }) as { ok: boolean };
        assertEqual(installed.ok, true, 'real archive acquisition completes through main IPC');
        assertEqual(readFileSync(join(root, 'skills/gui-zip/SKILL.md'), 'utf8'), downloaded, 'downloaded bytes retained');
        const list = JSON.stringify(await invoke('skills:list'));
        assert(list.includes('gui-upload') && list.includes('gui-zip'), 'the existing catalog sees both acquisitions');
        const market = await invoke('skills:market') as { items: unknown[]; isRemote: boolean };
        assert(Array.isArray(market.items) && market.isRemote === false, 'guest market reads the bundled catalog without requesting account credentials');
      } finally {
        await invoke('skills:uninstall', { name: 'gui-upload' }); await invoke('skills:uninstall', { name: 'gui-zip' });
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      }
    });
    await h.test('adding a marketplace through the renderer persists engine config without installing a plugin', async () => {
      const source = join(root, 'gui-market'); mkdirSync(join(source, '.claude-plugin'), { recursive: true });
      writeFileSync(join(source, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'gui-market', plugins: [] }));
      const ledgerPath = join(root, 'plugins/installed_plugins.json');
      const before = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : undefined;
      const added = await invoke('plugins:marketplace:add', { source }) as { ok: boolean; name: string };
      assert(added.ok && added.name === 'gui-market', 'main registrar reaches the actual acquisition owner');
      const config = await desktop.sessions.request('config/read', {}) as { values: { marketplaces: Record<string, { source: { path: string } }> } };
      assertEqual(config.values.marketplaces['gui-market']?.source.path, source, 'named engine config owns the source');
      assertEqual(existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : undefined, before, 'marketplace registration does not mutate installed plugins');
    });
    await h.test('Picture-in-Picture preferences and window ownership are composed into the actual main window', async () => {
      let phase = 'initial-state';
      try {
        desktop.show();
        const state = await invoke('computer-use-pip:get-state') as { supported: boolean; activeTaskIds: string[] };
        assertEqual(state.supported, process.platform === 'darwin', 'availability comes from the staged native capability and producer');
        const id = 'pip-gui-preference';
        for (let cycle = 0; cycle < 8; cycle++) {
          phase = `shown-preference-${cycle}`;
          await invoke('computer-use-pip:set-visibility', { scope: 'task', sessionId: id, visible: false });
          const stored = JSON.parse(kvGet('computer_use.pip.preferences', root) as string);
          assertEqual(stored.taskVisibilities[id], 'hidden', 'main settings transaction persisted the preference');
          phase = `hide-${cycle}`; desktop.window.hide();
          const hidden = await invoke('computer-use-pip:get-state') as { taskVisibilities: Record<string, string> };
          assertEqual(hidden.taskVisibilities[id], 'hidden', 'reading hidden state does not reactivate the native owner');
          phase = `show-${cycle}`; desktop.show();
          await invoke('computer-use-pip:set-visibility', { scope: 'task', sessionId: id, visible: true });
          assertEqual((await invoke('computer-use-pip:get-state') as { taskVisibilities: Record<string, string> }).taskVisibilities[id], 'shown', 'a fresh shown owner accepts preferences after actual hide drain');
        }
      } catch (error) {
        const rows = readFileSync(join(root, 'electron-host.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.kind === 'pip-owner').slice(-30);
        throw new Error(JSON.stringify({ phase, visible: desktop.window.isVisible(), minimized: desktop.window.isMinimized(), error: error instanceof Error ? error.message : error, rows }));
      }
    });
    await h.test('Discord gateway pairing uses the same access settings and shared engine as the desktop', async () => {
      let id: string | undefined;
      const f = discord!;
      try {
        const connected = await invoke('channels:connect', { id: 'discord', config: { bot_token: 'fixture.token' } }) as { ok: boolean };
        assertEqual(connected.ok, true, 'renderer starts the isolated gateway');
        await waitFor(async () => (await invoke('channels:list') as Array<{ id: string; connected: boolean }>).find(row => row.id === 'discord')?.connected === true, 5000, 'actual gateway READY');
        f.message({ id: '101', channel_id: '100', author: { id: '1', username: 'fixture-user' }, content: 'UNAPPROVED CHANNEL FIXTURE' });
        await waitFor(() => f.sends().length === 1, 5000, 'pairing response');
        assertEqual(await desktop.sessions.channelThread('discord:100'), undefined, 'unapproved message starts no engine task');
        const pending = await invoke('channels:discord:access') as { pending: Array<{ code: string }> };
        assertEqual(pending.pending.length, 1, 'main access settings read the gateway pairing');
        await invoke('channels:discord:approvePending', { code: pending.pending[0]!.code });
        await waitFor(() => f.sends().length === 2, 5000, 'gateway observes GUI approval');
        f.message({ id: '102', channel_id: '100', author: { id: '1', username: 'fixture-user' }, content: 'DISCORD APPROVED GUI FIXTURE' });
        await waitFor(() => f.sends().some(row => row.body.content === 'Fixture response complete.'), 20000, 'completed real engine response reaches Discord REST');
        const row = await desktop.sessions.channelThread('discord:100'); assert(typeof row?.id === 'string', 'engine persists the Discord thread mapping'); id = row.id;
        assert(JSON.stringify(await invoke('session:history', { sessionId: id })).includes('DISCORD APPROVED GUI FIXTURE'), 'the same conversation history contains inbound text');
        assertEqual(desktop.engine.liveProcessCount(), 1, 'no additional engine or host child is introduced');
      } finally { await invoke('channels:disconnect', { id: 'discord' }); if (id) await invoke('session:delete', { sessionId: id }); }
    });
    await h.test('WeCom actual callback receipts reuse the desktop engine and account takeover requires explicit reconnect', async () => {
      let id: string | undefined;
      const f = wecom!;
      try {
        assertEqual((await invoke('channels:connect', { id: 'wecom', config: { bot_id: 'gui-bot', secret: 'gui-secret' } }) as { ok: boolean }).ok, true, 'main IPC authenticates its isolated WebSocket');
        await waitFor(async () => (await invoke('channels:list') as Array<{ id: string; connected: boolean }>).find(row => row.id === 'wecom')?.connected === true, 5000, 'the server subscription was acknowledged');
        const callback = { cmd: 'aibot_msg_callback', headers: { req_id: 'gui-callback' }, body: { msgid: 'gui-message', chattype: 'single',
          from: { userid: 'gui-wecom-user' }, msgtype: 'text', text: { content: 'WECOM GUI REAL ENGINE FIXTURE' } } };
        f.send(callback);
        await waitFor(() => f.frames.some(row => row.value.cmd === 'aibot_respond_msg' && JSON.stringify(row.value.body).includes('Fixture response complete.')), 20000, 'the real engine response reached the matching WebSocket receipt');
        const response = f.frames.find(row => row.value.cmd === 'aibot_respond_msg')!.value;
        assertEqual((response.headers as Record<string, Json>).req_id, 'gui-callback', 'the answer keeps the original callback identity');
        const thread = await desktop.sessions.channelThread('wecom:gui-wecom-user'); assert(typeof thread?.id === 'string', 'the shared engine persisted the channel thread'); id = thread.id;
        assert(JSON.stringify(await invoke('session:history', { sessionId: id })).includes('WECOM GUI REAL ENGINE FIXTURE'), 'the actual desktop transcript contains the inbound channel turn');
        f.send({ cmd: 'aibot_event_callback', headers: { req_id: 'takeover' }, body: { event: { eventtype: 'disconnected_event' } } });
        await waitFor(async () => (await invoke('channels:list') as Array<{ id: string; status: { state: string } }>).find(row => row.id === 'wecom')?.status.state === 'stopped', 5000, 'account takeover stops the supervisor');
        assertEqual(f.count('aibot_subscribe'), 1, 'the stopped transport did not fight the newer connection');
        const saved = (await invoke('channels:list') as Array<{ id: string; credentials: Record<string, Json> }>).find(row => row.id === 'wecom')!;
        assertEqual((await invoke('channels:connect', { id: 'wecom', config: saved.credentials }) as { ok: boolean }).ok, true, 'the actual settings payload reconnects with its saved opaque credentials');
        await waitFor(() => f.count('aibot_subscribe') === 2, 5000, 'only the explicit action starts a new subscription');
        assertEqual(desktop.engine.liveProcessCount(), 1, 'both channel connections use the original one engine');
      } finally { await invoke('channels:disconnect', { id: 'wecom' }); if (id) await invoke('session:delete', { sessionId: id }); }
    });
    await h.test('QQ gateway messages reach the actual desktop engine and retain the passive reply identity', async () => {
      const f = qq!, user = 'a'.repeat(32); let id: string | undefined;
      try {
        assertEqual((await invoke('channels:connect', { id: 'qq', config: { app_id: '123456789', client_secret: 'gui-qq-fixture' } }) as { ok: boolean }).ok, true, 'real token and gateway owner started');
        await waitFor(async () => (await invoke('channels:list') as Array<{ id: string; connected: boolean }>).find(row => row.id === 'qq')?.connected === true, 5000, 'QQ gateway READY');
        f.send({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d: { id: 'gui-message', content: 'QQ GUI REAL ENGINE FIXTURE', author: { user_openid: user } } });
        await waitFor(() => f.messages().some(row => row.body.content === 'Fixture response complete.'), 20000, 'engine reply reaches actual QQ REST transport');
        const reply = f.messages().find(row => row.body.content === 'Fixture response complete.')!;
        assertEqual(reply.body.msg_id, 'gui-message', 'passive reply references the original gateway message');
        const row = await desktop.sessions.channelThread('qq:' + user); assert(typeof row?.id === 'string', 'one real engine thread is bound'); id = row.id;
        assert(JSON.stringify(await invoke('session:history', { sessionId: id })).includes('QQ GUI REAL ENGINE FIXTURE'), 'inbound text is present in actual desktop history');
        assertEqual(desktop.engine.liveProcessCount(), 1, 'the QQ owner uses the same single engine');
      } finally { await invoke('channels:disconnect', { id: 'qq' }); if (id) await invoke('session:delete', { sessionId: id }); }
    });
    await h.test('DingTalk Stream callbacks produce a real desktop engine turn and a confirmed terminal AI card', async () => {
      const f = dingtalk!; let id: string | undefined;
      try {
        assertEqual((await invoke('channels:connect', { id: 'dingtalk', config: { client_id: 'gui-dingtalk-key', client_secret: 'gui-dingtalk-secret' } }) as { ok: boolean }).ok, true, 'real gateway ticket and socket opened');
        f.send({ type: 'CALLBACK', headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'gui-dingtalk-message' }, data: JSON.stringify({
          msgtype: 'text', text: { content: 'DINGTALK GUI REAL ENGINE FIXTURE' }, conversationType: '1', conversationId: 'gui-dingtalk-dm',
          senderId: 'gui-dingtalk-sender', senderStaffId: 'gui-dingtalk-staff', senderNick: 'Fixture Sender', robotCode: 'gui-dingtalk-key', createAt: Date.now(),
        }) });
        await waitFor(() => f.cards().some(call => call.path.endsWith('/streaming') && call.body.isFinalize === true && call.body.content === 'Fixture response complete.'), 20000, 'actual model reply reaches the terminal card API');
        assert(f.cards().some(call => call.path.endsWith('/deliver') && call.body.openSpaceId === 'dtv1.card//IM_ROBOT.gui-dingtalk-staff'), 'card delivery uses the vendor staff identity');
        assert(f.frames.some(frame => frame.value.code === 200 && JSON.stringify(frame.value).includes('gui-dingtalk-message')), 'the originating callback was acknowledged');
        const row = await desktop.sessions.channelThread('dingtalk:gui-dingtalk-sender'); assert(typeof row?.id === 'string', 'the incoming conversation has one persisted engine thread'); id = row.id;
        assert(JSON.stringify(await invoke('session:history', { sessionId: id })).includes('DINGTALK GUI REAL ENGINE FIXTURE'), 'the original text is present in desktop history');
        assertEqual(desktop.engine.liveProcessCount(), 1, 'DingTalk uses the original engine');
      } finally { await invoke('channels:disconnect', { id: 'dingtalk' }); if (id) await invoke('session:delete', { sessionId: id }); }
    });
    await h.test('WeChat QR pairing routes real HTTP messages through one resumable engine conversation', async () => {
      const transport = await createWechatTransportFixture(); let id: string | undefined;
      try {
        kvSet('channel.wechat.base_url', transport.base, root);
        const qr = await invoke('channels:wechat:qrStart') as { ok: boolean; qrcodeDataUrl: string };
        assert(qr.ok && qr.qrcodeDataUrl.startsWith('data:image/png;base64,'), 'actual QR encoder produces a displayable PNG');
        assertEqual((await invoke('channels:wechat:qrPoll') as { status: string }).status, 'confirmed', 'pairing starts the real transport');
        await waitFor(() => transport.polls() === 1, 5000, 'actual inbound long poll');
        const incoming = { message_id: 'gui-message-1', message_type: 1, from_user_id: 'gui-sender', context_token: 'fixture-context', item_list: [{ type: 1, text_item: { text: 'CHANNEL GUI FIXTURE' } }] };
        transport.answer({ msgs: [incoming, incoming], get_updates_buf: 'cursor-gui-1' });
        await waitFor(() => transport.sends().length === 1, 20000, 'engine final text reaches actual channel HTTP');
        const row = await desktop.sessions.channelThread('wechat:gui-sender');
        assert(typeof row?.id === 'string', 'engine persisted the channel mapping'); id = row.id;
        assert(id !== 'wechat:gui-sender', 'new storage identity is portable across platforms');
        assertEqual(desktop.engine.liveProcessCount(), 1, 'channel uses the shared engine child');
        const msg = transport.sends()[0]!.body.msg as Record<string, Json>;
        assertEqual(msg.to_user_id, 'gui-sender', 'reply returns to the source sender');
        assertEqual(((msg.item_list as Array<Record<string, Json>>)[0]!.text_item as Record<string, Json>).text, 'Fixture response complete.', 'only the completed assistant text is sent');
        assertEqual(transport.sends()[0]!.headers.authorization, 'Bearer fixture-bot-token', 'paired fixture credential reaches only the transport');
        const history = JSON.stringify(await invoke('session:history', { sessionId: id }));
        assert(history.includes('CHANNEL GUI FIXTURE') && history.includes('Fixture response complete.'), 'both sides survive in engine history');
        await desktop.window.webContents.executeJavaScript(`window.klausSwitchSession(${JSON.stringify(id)})`);
        await waitFor(() => desktop.window.webContents.executeJavaScript("document.body.innerText.includes('CHANNEL GUI FIXTURE')"), 10000, 'actual transcript displays the channel conversation');
        await invoke('session:archive', { sessionId: id });
        await waitFor(() => transport.polls() >= 2, 5000, 'next inbound poll');
        transport.answer({ msgs: [{ ...incoming, message_id: 'gui-message-2' }], get_updates_buf: 'cursor-gui-2' });
        await waitFor(() => transport.sends().length === 2, 20000, 'archived conversation resumes on a new message');
        assertEqual((await desktop.sessions.channelThread('wechat:gui-sender'))?.id, id, 'durable metadata routes to the same restored thread');
        assertEqual((await invoke('channels:list') as Array<{ id: string; connected: boolean }>).find(row => row.id === 'wechat')?.connected, true, 'renderer reports actual transport state');
        assertEqual((await invoke('channels:wechat:qrStart') as { ok: boolean }).ok, true, 'new pairing flow is pending');
        await invoke('channels:disconnect', { id: 'wechat' });
        assertEqual((await invoke('channels:wechat:qrPoll') as { ok: boolean }).ok, false, 'disconnect cancels pending pairing before it can reconnect the account');
      } finally {
        await invoke('channels:disconnect', { id: 'wechat' }); await transport.close();
        if (id) await invoke('session:delete', { sessionId: id });
      }
    });
    await h.test('permission edits refresh the existing engine session without replacing its live context', async () => {
      const row = await invoke('session:new') as { id: string };
      await invoke('chat:send', { sessionId: row.id, text: 'PERMISSION CONTEXT FIXTURE' });
      await waitFor(async () => !(await invoke('session:list') as Array<{ id: string; isWorking: boolean }>).find(item => item.id === row.id)?.isWorking, 10000, 'initial context completed');
      const live = await desktop.sessions.resolveLiveSession(row.id), history = JSON.stringify(await invoke('session:history', { sessionId: row.id }));
      const client = desktop.sessions.engine()!.client, original = client.requestWithTimeout.bind(client), calls: string[] = [], reloads: string[] = [];
      client.requestWithTimeout = async (method, params, timeoutMs) => {
        calls.push(method); if (method === 'session/reloadPermissionRules') reloads.push(String(object(params).sessionId));
        return original(method, params, timeoutMs);
      };
      const rule = { toolName: 'Bash', ruleContent: 'echo channel-permission-fixture', behavior: 'ask' };
      try {
        assertEqual((await invoke('permission:rules:add', rule) as { ok: boolean }).ok, true, 'engine saves and refreshes the rule');
        assert((await invoke('permission:rules:list') as { ask: Array<{ ruleContent: string }> }).ask.some(item => item.ruleContent === rule.ruleContent), 'renderer reads the engine-owned store');
        assertEqual((await invoke('permission:rules:delete', rule) as { ok: boolean }).ok, true, 'removal refreshes the same session');
        assertEqual(reloads.filter(id => id === live).length, 2, 'each edit uses the named facade for this live session');
        assert(!calls.includes('session/close') && !calls.includes('session/start'), 'permission edits preserve the actual endpoint');
        assertEqual(await desktop.sessions.resolveLiveSession(row.id), live, 'live engine identity retained');
        assertEqual(JSON.stringify(await invoke('session:history', { sessionId: row.id })), history, 'context is unchanged');
      } finally {
        client.requestWithTimeout = original; await invoke('permission:rules:delete', rule); await invoke('session:delete', { sessionId: row.id });
      }
    });
    await h.test('an unavailable session list does not prevent workbench startup', async () => {
      const list = desktop.sessions.listSessions;
      desktop.sessions.listSessions = async () => { throw new Error('Injected list transport failure'); };
      try {
        await desktop.window.webContents.loadURL(desktop.window.webContents.getURL());
        await waitFor(() => desktop.window.webContents.executeJavaScript(`(() => {
          const boot = document.getElementById('boot-screen');
          return (!boot || getComputedStyle(boot).display === 'none')
            && typeof window.updateSessionInList === 'function'
            && document.body.innerText.match(/会话列表刷新失败|Could not refresh conversations/);
        })()`), 15000, 'startup continues and reports the list failure');
        assertEqual(await desktop.window.webContents.executeJavaScript('window.currentSessionId'), null, 'new-chat setup ran after the failure');
      } finally { desktop.sessions.listSessions = list; }
    });
    await h.test('using an Agent creates one atomic composer chip instead of raw mention text', async () => {
      await desktop.window.webContents.executeJavaScript("document.getElementById('btn-agents').click()");
      await waitFor(() => desktop.window.webContents.executeJavaScript(`Boolean(document.querySelector('#agents-view [data-agent-name="Explore"] .btn-xs'))`), 10000, 'built-in Explore Agent is available');
      await desktop.window.webContents.executeJavaScript(`document.querySelector('#agents-view [data-agent-name="Explore"] .btn-xs').click()`);
      await waitFor(() => desktop.window.webContents.executeJavaScript(`Boolean(document.querySelector('#input [data-klaus-composer-token-value="@agent-Explore"]'))`), 10000, 'Agent use action inserted an atomic composer chip');
      const agentDraft = await desktop.window.webContents.executeJavaScript(`(() => {
        const input = document.getElementById('input');
        const tokens = Array.from(input.querySelectorAll('[data-klaus-composer-token-value]'));
        return { value: input.value, tokens: tokens.map(token => ({ value: token.getAttribute('data-klaus-composer-token-value'), text: token.textContent })) };
      })()`) as { value: string; tokens: Array<{ value: string; text: string }> };
      assertEqual(agentDraft.value, '@agent-Explore ', 'model-facing Agent mention remains unchanged');
      assertEqual(JSON.stringify(agentDraft.tokens), JSON.stringify([{ value: '@agent-Explore', text: 'Explore' }]), 'composer keeps one identity-bearing Agent chip');
    });
    await h.test('guest startup reaches the current composer and a DOM submission renders streamed text', async () => {
      await waitFor(() => desktop.window.webContents.executeJavaScript(`(() => {
        const boot = document.getElementById('boot-screen');
        return (!boot || getComputedStyle(boot).display === 'none')
          ;
      })()`), 15000, 'workbench startup completed');
      await desktop.window.webContents.executeJavaScript(`(() => {
        const input = document.getElementById('input');
        input.textContent = 'PLAIN FIXTURE from the current composer';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      })()`);
      await waitFor(() => desktop.window.webContents.executeJavaScript("!document.getElementById('send').disabled"), 10000, 'composer is ready to send');
      await desktop.window.webContents.executeJavaScript("document.getElementById('send').click()");
      await waitFor(() => desktop.window.webContents.executeJavaScript("document.getElementById('messages').innerText.includes('Fixture response complete.')"), 30000, 'the transcript rendered the actual response');
      const sessionId = await desktop.window.webContents.executeJavaScript('window.currentSessionId') as string;
      await waitFor(async () => {
        const row = (await invoke('session:list') as Array<{id:string;title:string;isWorking:boolean}>).find(item => item.id === sessionId);
        return row?.isWorking === false && !['', 'New Chat', 'Chat', '新对话'].includes(String(row.title || '').trim());
      }, 10000, 'DOM conversation completed with a persisted title');
      await waitFor(() => desktop.window.webContents.executeJavaScript(`(() => {
        const row = document.querySelector('#session-list .active');
        const text = row?.textContent?.trim() || '';
        return Boolean(row && !row.classList.contains('is-working') && text && !['New Chat', 'Chat', '新对话'].includes(text));
      })()`), 10000, 'sidebar title replaces its placeholder and clears the running indicator');
      const savedPolicy = await invoke('session:get-permission-mode', { sessionId });
      await invoke('session:set-collaboration-mode', { sessionId, mode: 'plan' });
      assertEqual(JSON.stringify(await invoke('session:get-permission-mode', { sessionId })), JSON.stringify(savedPolicy), 'planning preserves the selected permission policy');
      assertEqual((await invoke('session:get-collaboration-mode', { sessionId }) as { planning: { mode: string } }).planning.mode, 'plan', 'engine persists the independent mode');
      await invoke('session:set-collaboration-mode', { sessionId, mode: 'default' });
    });
    await h.test('Quick Input submits through its restricted window and the actual composer without duplicate conversations', async () => {
      const previous = await desktop.window.webContents.executeJavaScript('window.currentSessionId') as string;
      const shown = await desktop.showQuickInput(); assert(shown.ok, `Quick Input opened: ${shown.error}`);
      const quick = BrowserWindow.getAllWindows().find(owner=>owner.webContents.getURL().includes('/quick-input.html'));
      assert(quick && quick.isVisible(), 'the production Quick Input window is visible');
      assertEqual(await quick.webContents.executeJavaScript('typeof window.process'),'undefined','the quick page has no Node access');
      await assertRejects(()=>quick.webContents.executeJavaScript(`window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke',{channel:'settings:kv:get',args:[{key:'auth_mode'}]})`),'the quick window cannot inspect main settings');
      await quick.webContents.executeJavaScript(`document.getElementById('qi-input').value = 'PLAIN FIXTURE from quick input'`);
      quick.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
      quick.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
      await waitFor(()=>desktop.window.webContents.executeJavaScript(`window.currentSessionId !== ${JSON.stringify(previous)} && document.getElementById('messages').innerText.includes('Fixture response complete.')`),15000,'Quick Input reached a new real conversation');
      const id = await desktop.window.webContents.executeJavaScript('window.currentSessionId') as string;
      const history = await invoke('session:history',{sessionId:id}) as {messages:Array<{role:string;text:string}>};
      assertEqual(history.messages.filter(message=>message.role==='user' && message.text==='PLAIN FIXTURE from quick input').length,1,'the entered message was persisted once');
      await waitFor(()=>!quick.isVisible(),5000,'accepted input closed the transient card');
      const value = {text:'PLAIN FIXTURE duplicate delivery',submissionId:'gui-quick-input-dedup'};
      await Promise.all([desktop.deliver(desktop.window.webContents.id,'quick-input:submit',value),desktop.deliver(desktop.window.webContents.id,'quick-input:submit',value)]);
      const deduplicated = await desktop.window.webContents.executeJavaScript('window.currentSessionId') as string;
      await waitFor(async()=>!(await invoke('session:list') as Array<{id:string;isWorking:boolean}>).find(row=>row.id===deduplicated)?.isWorking,10000,'deduplicated turn completed');
      await desktop.deliver(desktop.window.webContents.id,'quick-input:submit',value);
      assertEqual(await desktop.window.webContents.executeJavaScript('window.currentSessionId'),deduplicated,'a confirmed replay cannot enter another new conversation');
      const repeated = await invoke('session:history',{sessionId:deduplicated}) as {messages:Array<{role:string;text:string}>};
      assertEqual(repeated.messages.filter(message=>message.role==='user' && message.text===value.text).length,1,'repeated acknowledged pushes sent once');
    });
    await h.test('clipboard and system permission channels preserve narrow results without writing system settings', async () => {
      assertEqual(clipboardReads,0,'startup never reads clipboard contents');
      const paths = await invoke('clipboard:read-file-paths') as string[];
      assertEqual(paths.length,1,'only the copied fixture file'); assertEqual(paths[0],pastedPath,'Unicode file path reaches the bridge intact');
      assertEqual(clipboardReads,1,'one explicit clipboard request');
      const status = await invoke('system:permissions:check') as {platform:string;supported:boolean;permissions:Record<string,string>};
      assertEqual(status.supported,process.platform==='darwin','platform support is reported honestly');
      assertEqual((await invoke('system:permissions:open',{type:'not-a-permission'}) as {ok:boolean}).ok,false,'unrecognized settings destinations are rejected');
    });
    await h.test('voice input uses the actual composer bridge and drains synthetic audio before inserting its final text', async () => {
      kvSet('voice.polish.enabled', 'false', root!);
      desktop.show();
      await desktop.window.webContents.executeJavaScript(`(() => {
        window.__voiceOriginalGetUserMedia = Object.getOwnPropertyDescriptor(navigator.mediaDevices, 'getUserMedia');
        window.__voiceSources = [];
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
          const context = new AudioContext(), oscillator = context.createOscillator(), output = context.createMediaStreamDestination();
          window.__voiceSources.push(context); oscillator.connect(output); oscillator.start(); await context.resume();
          window.__voiceLastStream = output.stream; return output.stream;
        } });
        window.__voiceReceived = [];
        window.__voiceUnsubscribe = window.klaus.voice.onSessionEvent(event => window.__voiceReceived.push(event));
        document.getElementById('input').textContent = '';
      })()`);
      const click = () => desktop.window.webContents.executeJavaScript(`(() => {
        const button = document.getElementById('voice-input-btn');
        button.dispatchEvent(new PointerEvent('pointerdown', {button:0}));
        button.dispatchEvent(new PointerEvent('pointerup', {button:0})); button.click();
      })()`, true);
      try {
        assertEqual((await invoke('voice:config:get') as {systemAsr:boolean}).systemAsr, true, 'host helper capability reaches current UI');
        await click();
        await waitFor(() => desktop.window.webContents.executeJavaScript("document.getElementById('voice-input-btn').dataset.voiceState === 'recording'"), 10000, 'actual voice UI recording synthetic audio');
        await new Promise(resolve => setTimeout(resolve, 245)); await click();
        await waitFor(() => desktop.window.webContents.executeJavaScript("/pcm:[0-9]+:[a-f0-9]{64}/.test(document.getElementById('input').textContent)"), 10000, 'actual composer receives helper final');
        const report = await desktop.window.webContents.executeJavaScript(`({ text:document.getElementById('input').textContent,
          ended:window.__voiceLastStream.getAudioTracks().every(track=>track.readyState==='ended'), events:window.__voiceReceived })`) as {text:string;ended:boolean;events:Array<{type:string;seq:number;text?:string}>};
        assert(report.ended, 'microphone tracks released');
        assert(report.events.some(event => event.type === 'final' && report.text.includes(event.text!)), 'acknowledged final reaches the normal voice subscriber');
        assert(report.events.every((event, index) => event.seq === index + 1), 'actual voice events remain ordered');
        const history = await invoke('voice:history:list') as Array<{finalText:string}>;
        assert(history.some(row => report.text.includes(row.finalText)), 'system transcript persisted after completion');
        await click();
        await waitFor(() => desktop.window.webContents.executeJavaScript("document.getElementById('voice-input-btn').dataset.voiceState === 'recording'"), 10000, 'second recording active');
        desktop.window.hide();
        await waitFor(() => desktop.window.webContents.executeJavaScript("window.__voiceLastStream.getAudioTracks().every(track=>track.readyState==='ended')"), 10000, 'hiding stops actual renderer capture');
      } finally {
        desktop.show();
        await desktop.window.webContents.executeJavaScript(`(async () => {
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
          window.__voiceUnsubscribe?.(); await Promise.all(window.__voiceSources.map(context=>context.close()));
          if(window.__voiceOriginalGetUserMedia) Object.defineProperty(navigator.mediaDevices,'getUserMedia',window.__voiceOriginalGetUserMedia);
          else delete navigator.mediaDevices.getUserMedia;
          document.getElementById('input').textContent='';
        })()`);
      }
    });
    await h.test('cloud voice obtains its BYO key through the real engine and sends actual multipart audio', async () => {
      let calls = 0, valid = false;
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString(); calls++;
        valid = request.url === '/v1/audio/transcriptions' && request.headers.authorization === 'Bearer voice-fixture-key'
          && String(request.headers['content-type']).startsWith('multipart/form-data;') && body.includes('name="file"') && body.includes('voice-fixture-bytes');
        response.writeHead(valid ? 200 : 400, {'Content-Type':'application/json'}); response.end(JSON.stringify({text:'Voice cloud fixture.'}));
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); assert(address && typeof address === 'object', 'voice fixture server bound');
      try {
        await desktop.sessions.request('config/batchWrite', {edits:[{keyPath:'modelProviders.voiceFixture',mergeStrategy:'replace',value:{name:'Voice fixture',provider:'openai',model:'whisper-1',baseUrl:`http://127.0.0.1:${address.port}/v1`}}]});
        await desktop.sessions.request('model/credential/write', {id:'voiceFixture',apiKey:'voice-fixture-key'});
        const result = await invoke('voice:transcribe', {operationId:'cloud-voice-fixture',mimeType:'audio/webm',data:{__klausBinary:Buffer.from('voice-fixture-bytes').toString('base64')}}) as {ok:boolean;text:string};
        assert(result.ok && result.text === 'Voice cloud fixture.', 'actual cloud transcript returned');
        assertEqual(calls, 1, 'one actual provider call'); assert(valid, 'real saved credential and multipart bytes reach selected endpoint');
      } finally {
        await desktop.sessions.request('model/credential/delete', {id:'voiceFixture'});
        await desktop.sessions.request('config/batchWrite', {edits:[{keyPath:'modelProviders.voiceFixture',mergeStrategy:'replace',value:null}]});
        server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
    await h.test('side questions keep the conversation intact and cancellation closes actual provider work', async () => {
      const row=await invoke('session:new') as {id:string};
      const emptyCompaction=await invoke('engine:compactSession',{sessionId:row.id}) as {ok:boolean;notice?:string};
      assert(!emptyCompaction.ok && !!emptyCompaction.notice,'actual empty compaction returns its no-op notice');
      await invoke('chat:send',{sessionId:row.id,text:'PLAIN FIXTURE side question parent'});
      await waitFor(async()=>!(await invoke('session:list') as Array<{id:string;isWorking:boolean}>).find(item=>item.id===row.id)?.isWorking,15000,'parent turn completed');
      const before=JSON.stringify(await invoke('session:history',{sessionId:row.id}));
      const stats=await invoke('engine:contextStats',{sessionId:row.id}) as {tokens:number;maxTokens:number;categories:unknown[]};
      assert(Number.isFinite(stats.tokens) && stats.maxTokens>0 && Array.isArray(stats.categories),'actual snapshot satisfies the context monitor contract');
      const answer=await invoke('chat:side-question',{sessionId:row.id,question:'A separate short question',requestId:'gui-side-question'}) as {ok:boolean;response:string};
      assert(answer.ok && answer.response.includes('Fixture response complete.'),'actual engine answer returned');
      assertEqual(JSON.stringify(await invoke('session:history',{sessionId:row.id})),before,'side answer does not enter parent history');
      const started=provider!.sideQuestions.started,closed=provider!.sideQuestions.closed;
      const pending=invoke('chat:side-question',{sessionId:row.id,question:'SIDE QUESTION HOLD FIXTURE cancel',requestId:'gui-side-cancel'});
      void pending.catch(()=>{});
      await waitFor(()=>provider!.sideQuestions.started>started,15000,'actual provider received the question');
      assertEqual((await invoke('chat:side-question:cancel',{requestId:'gui-side-cancel'}) as {cancelled:boolean}).cancelled,true,'cancel reached the engine terminal outcome');
      assertEqual((await pending as {cancelled:boolean}).cancelled,true,'original renderer request settled as cancelled');
      await waitFor(()=>provider!.sideQuestions.closed>closed && provider!.sideQuestions.active===0,10000,'actual HTTP work was disconnected');
      assertEqual(JSON.stringify(await invoke('session:history',{sessionId:row.id})),before,'cancellation preserved the main conversation');
      const deleting=invoke('chat:side-question',{sessionId:row.id,question:'SIDE QUESTION HOLD FIXTURE close',requestId:'gui-side-close'});
      void deleting.catch(()=>{});
      await waitFor(()=>provider!.sideQuestions.active===1,15000,'question pending at conversation close');
      await invoke('session:delete',{sessionId:row.id});
      assertEqual((await deleting as {cancelled:boolean}).cancelled,true,'conversation deletion cancels its question');
      await waitFor(()=>provider!.sideQuestions.active===0,10000,'deleted conversation owns no provider work');
    });
    await h.test('the actual composer model change preserves the live session and applies project inference settings', async () => {
      const defaultModel = await invoke('session:get-main-model') as {mode:string;source:string};
      const directory = join(root, 'model-project'); mkdirSync(join(directory, '.klaus'), { recursive: true });
      writeFileSync(join(directory, '.klaus/config.toml'), 'maxOutputTokens = 2048\n');
      const row = await invoke('session:new', { workdir: directory }) as { id: string };
      try {
        await invoke('chat:send', {sessionId:row.id,text:'PLAIN FIXTURE before model replacement'});
        await waitFor(async()=>!(await invoke('session:list') as Array<{id:string;isWorking:boolean}>).find(item=>item.id===row.id)?.isWorking,15000,'initial model turn finished');
        const engineId = await desktop.sessions.resolveLiveSession(row.id);
        const before = await desktop.sessions.request('session/modelRuntime', {sessionId:engineId}) as {revision:number};
        const pid = desktop.sessions.engine()!.client;
        const history = await invoke('session:history', {sessionId:row.id}) as {messages:Json[]};
        await desktop.sessions.request('config/batchWrite', { edits: [{ keyPath: 'modelProviders.replacementFixture', mergeStrategy: 'replace', value: {
          name:'Replacement fixture',provider:'anthropic',model:'fixture-replacement',baseUrl:provider!.url,
          maxContextTokens:160000,thinking:'off',capabilities:{contextWindow:160000,vision:true},
        } }] });
        await desktop.sessions.request('model/credential/write', {id:'replacementFixture',apiKey:'replacement-fixture-key'});
        await invoke('session:set-main-model', {sessionId:row.id,mode:'custom:replacementFixture',source:'custom'});
        assertEqual(JSON.stringify(await invoke('session:history', {sessionId:row.id})),JSON.stringify(history),'reading after the setting keeps the existing transcript');
        await waitFor(async () => (await desktop.sessions.request('session/modelRuntime', {sessionId:engineId}) as {revision:number}).revision === before.revision + 1, 15000, 'the live selection publishes without waiting for another chat message');
        await invoke('chat:send', {sessionId:row.id,text:'PLAIN FIXTURE after model replacement'});
        await waitFor(async()=>!(await invoke('session:list') as Array<{id:string;isWorking:boolean}>).find(item=>item.id===row.id)?.isWorking,15000,'replacement model turn finished');
        const current = await desktop.sessions.request('session/modelRuntime', {sessionId:engineId}) as {revision:number;model:string;maxOutputTokens:number};
        assertEqual(current.revision,before.revision+1,'one atomic replacement on the original engine session');
        assertEqual(current.model,'fixture-replacement','the actual engine uses the chosen model');
        assertEqual(current.maxOutputTokens,2048,'the project output pin survives replacement');
        assertEqual(await desktop.sessions.resolveLiveSession(row.id),engineId,'same live conversation identity');
        assertEqual(desktop.sessions.engine()!.client,pid,'same engine connection');
        const sent = provider!.requests.find(request=>JSON.stringify(request.messages).includes('PLAIN FIXTURE after model replacement'));
        assert(sent && sent.model==='fixture-replacement','new provider request carries the replacement model');
        assert(JSON.stringify(sent.messages).includes('PLAIN FIXTURE before model replacement'),'new provider retains prior context');
        const after = await invoke('session:history',{sessionId:row.id}) as {messages:Json[]};
        assertEqual(after.messages.length,history.messages.length+2,'history has one new user and assistant turn');
      } finally {
        await invoke('session:set-main-model',{mode:defaultModel.mode,source:defaultModel.source});
        await invoke('session:delete',{sessionId:row.id});
        await desktop.sessions.request('model/credential/delete',{id:'replacementFixture'});
        await desktop.sessions.request('config/batchWrite',{edits:[{keyPath:'modelProviders.replacementFixture',mergeStrategy:'replace',value:null}]});
      }
    });
    await h.test('a failed sidebar refresh preserves the last conversation and then recovers', async () => {
      const id = await desktop.window.webContents.executeJavaScript('window.currentSessionId') as string;
      await desktop.window.webContents.executeJavaScript('window.updateSessionInList()');
      const rowQuery = `Boolean(window.getKnownSessionInfo(${JSON.stringify(id)}) && document.querySelector('#session-list .active'))`;
      await waitFor(() => desktop.window.webContents.executeJavaScript(rowQuery), 5000, 'the completed conversation is listed');
      const list = desktop.sessions.listSessions;
      desktop.sessions.listSessions = async () => { throw new Error('Injected later refresh failure'); };
      try {
        await desktop.window.webContents.executeJavaScript('window.updateSessionInList()');
        assertEqual(await desktop.window.webContents.executeJavaScript(rowQuery), true, 'failure retained the row');
        assertEqual(await desktop.window.webContents.executeJavaScript('window.currentSessionId'), id, 'failure retained the active conversation');
      } finally { desktop.sessions.listSessions = list; }
      await desktop.window.webContents.executeJavaScript('window.updateSessionInList()');
      assertEqual(await desktop.window.webContents.executeJavaScript(rowQuery), true, 'a later successful refresh recovers');
    });
    // Page-scoped recorder. Any test that reloads the page MUST call this again:
    // the listeners live in the page context, so a reload silently drops them and
    // every later `records()` call resolves to undefined.
    const installFixtureEventRecorder = async (): Promise<void> => {
      await desktop.window.webContents.executeJavaScript(`(() => {
        window.__fixtureEvents = [];
        for (const channel of ['chat:event:batch', 'permission:request', 'elicit:request']) {
          window.__KLAUS_DESKTOP__.event.listen('ipc:' + channel, event => {
            window.__fixtureEvents.push({channel, value:event.payload.args[0]});
          });
        }
      })()`);
    };
    await installFixtureEventRecorder();
    await h.test('production IPC awaits the asynchronous renderer consumer', async () => {
      await desktop.window.webContents.executeJavaScript(`(() => {
        window.__fixtureConsumed = false;
        window.__KLAUS_DESKTOP__.event.listen('ipc:terminal:data', () => new Promise(resolve => {
          setTimeout(() => { window.__fixtureConsumed = true; resolve(); }, 60);
        }));
      })()`);
      await desktop.deliver(desktop.window.webContents.id, 'terminal:data', { id: 'fixture-pty', data: 'bounded output' });
      assertEqual(await desktop.window.webContents.executeJavaScript('window.__fixtureConsumed'), true, 'ACK follows completion across the context bridge');
    });
    await h.test('the current terminal panel owns a real native PTY and drains its output', async () => {
      await desktop.window.webContents.executeJavaScript(`(() => {
        window.__terminalOutput = [];
        window.__terminalExited = null;
        window.__KLAUS_DESKTOP__.event.listen('ipc:terminal:data', event => window.__terminalOutput.push(event.payload.args[0]));
        window.__KLAUS_DESKTOP__.event.listen('ipc:terminal:exit', event => { window.__terminalExited = event.payload.args[0]; });
      })()`);
      let id: string | undefined;
      try {
        await desktop.window.webContents.executeJavaScript('window.klausNewTerminal()');
        await waitFor(() => desktop.nativeCounts().ptys === 1, 10000, 'native PTY opened from the current terminal panel');
        await waitFor(() => desktop.window.webContents.executeJavaScript('window.__terminalOutput.length > 0'), 10000, 'shell prompt rendered');
        id = await desktop.window.webContents.executeJavaScript('window.__terminalOutput[0].id') as string;
        // Split the marker so echoed input cannot masquerade as shell output.
        const data = process.platform === 'win32'
          ? 'set "KLAUS_FIXTURE_TERMINAL=CONSUMED"\r\necho TERMINAL_%KLAUS_FIXTURE_TERMINAL%\r\nexit 0\r\n'
          : "printf '\\nTERMINAL_%s\\n' 'CONSUMED'; exit 0\n";
        assertEqual(object(await invoke('terminal:write', { id, data })).ok, true, 'the actual PTY accepted the command');
        await waitFor(() => desktop.window.webContents.executeJavaScript("window.__terminalOutput.map(row => row.data).join('').includes('TERMINAL_CONSUMED')"), 10000, 'actual shell output reached the consumer');
        await waitFor(() => desktop.window.webContents.executeJavaScript(`window.__terminalExited?.id === ${JSON.stringify(id)}`), 10000, 'terminal exit reached the renderer');
        await waitFor(() => desktop.nativeCounts().ptys === 0, 10000, 'native PTY released after delivery');
      } finally {
        if (id) {
          assertEqual(object(await invoke('terminal:kill', { id })).ok, true, 'the terminal fixture confirmed cleanup');
        } else {
          // The panel owns its terminal IDs before the shell produces output.
          await desktop.window.webContents.executeJavaScript('window.klausCloseTerminalPanel()');
        }
        await waitFor(() => desktop.nativeCounts().ptys === 0, 10000, 'the terminal fixture leaves no writer for later cases');
      }
    });
    const records = (): Promise<Array<{ channel: string; value: Json }>> => desktop.window.webContents.executeJavaScript('window.__fixtureEvents');
    await testComputerUseApp({ h, desktop, invoke, records, root });
    await h.test('update IPC stays unavailable in development and the sidebar action retracts revoked offers', async () => {
      const status = await invoke('updater:status') as {supported:boolean;state:string};
      assertEqual(status.supported, false, 'unsigned development cannot fetch or install a release');
      assertEqual((await invoke('updater:check') as {supported:boolean}).supported, false, 'manual check preserves unsupported status');
      const offered = {supported:true,state:'downloaded',currentVersion:app.getVersion(),availableVersion:'0.3.99',error:null};
      const publish = async (value: Json) => { await desktop.deliver(desktop.window.webContents.id, 'updater:status', value); };
      await publish(offered);
      await waitFor(() => desktop.window.webContents.executeJavaScript("!document.getElementById('sidebar-update-restart').hidden"), 5000, 'the sidebar shows a downloaded offer');
      assertEqual(await desktop.window.webContents.executeJavaScript("document.getElementById('sidebar-update-restart').nextElementSibling?.id"), 'sidebar-user-usage', 'the update action occupies the footer slot before usage and settings');
      const updateFrame = await desktop.window.webContents.capturePage(undefined, { stayHidden: true });
      assert(!updateFrame.isEmpty(), 'the update action paints in the real workbench');
      writeFileSync(join(__dirname, 'update-control-current.png'), updateFrame.toPNG());
      const footerBounds = await desktop.window.webContents.executeJavaScript("(() => { const rect = document.querySelector('.sidebar-footer').getBoundingClientRect(); return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) }; })()") as {x:number;y:number;width:number;height:number};
      const updateFooter = await desktop.window.webContents.capturePage(footerBounds, { stayHidden: true });
      assert(!updateFooter.isEmpty(), 'the focused update footer capture is non-empty');
      writeFileSync(join(__dirname, 'update-control-footer-current.png'), updateFooter.toPNG());
      await publish({...offered,state:'error',availableVersion:null,error:'Fixture release revoked'});
      assertEqual(await desktop.window.webContents.executeJavaScript("document.getElementById('sidebar-update-restart').hidden"), true, 'revocation removes the install affordance');
      await publish(offered);
      assertEqual(await desktop.window.webContents.executeJavaScript("!document.getElementById('sidebar-update-restart').hidden"), true, 'a later verified offer may reuse the displayed version');
      const busy = await desktop.window.webContents.executeJavaScript("(() => { const button = document.getElementById('sidebar-update-restart'); button.click(); return { disabled: button.disabled, busy: button.getAttribute('aria-busy'), text: button.textContent }; })()") as {disabled:boolean;busy:string;text:string};
      assertEqual(busy.disabled, true, 'click disables duplicate update requests immediately');
      assertEqual(busy.busy, 'true', 'click exposes the update preparation state to assistive technology');
      assert(/Preparing|正在准备/.test(busy.text), 'click gives immediate visible update preparation feedback');
      await waitFor(() => desktop.window.webContents.executeJavaScript("!document.getElementById('sidebar-update-restart').disabled && !document.getElementById('sidebar-update-restart').hasAttribute('aria-busy') && /The update could not be installed|更新未能安装/.test(document.body.innerText)"), 5000, 'a real unavailable install response surfaces a readable error and restores the action');
      await publish({...offered,supported:false,state:'idle',availableVersion:null});
    });
    await h.test('actual side-task chat keeps hidden parent context and promotes it into a persistent conversation', async () => {
      const defaults = await invoke('session:get-main-model') as {mode:string;source:string};
      const parent = await invoke('session:new') as {id:string};
      let sideId: string | undefined, branchId: string | undefined;
      let composerBefore: unknown;
      const doneCount = async (id: string) => (await records()).filter(record => record.channel === 'chat:event:batch'
        && (record.value as Array<{type:string;sessionId:string}>).some(event => event.type === 'done' && event.sessionId === id)).length;
      const turn = async (id: string, text: string) => {
        const before = await doneCount(id); await invoke('chat:send', {sessionId:id,text});
        await waitFor(async () => await doneCount(id) > before, 15000, 'actual side-task fixture turn finished');
      };
      try {
        await turn(parent.id, 'PLAIN FIXTURE inherited side-task context one');
        await turn(parent.id, 'PLAIN FIXTURE inherited side-task context two');
        const parentHistory = JSON.stringify(await invoke('session:history', {sessionId:parent.id}));
        await desktop.window.webContents.executeJavaScript(`window.switchSession(${JSON.stringify(parent.id)})`);
        await desktop.window.webContents.executeJavaScript(`window.KlausSideTasks.refresh(${JSON.stringify(parent.id)})`);
        assertEqual(await desktop.window.webContents.executeJavaScript('window.KlausSideTasks.canCreate()'), true, 'real side-task UI admits a parent with history');
        await desktop.window.webContents.executeJavaScript('window.KlausSideTasks.create()');
        sideId = await desktop.window.webContents.executeJavaScript('window.KlausSideTasks.getActiveSideId()') as string;
        assert(sideId, 'real side-task create activates its side surface');
        assertEqual((await invoke('session:history', {sessionId:sideId}) as {messages:unknown[]}).messages.length, 0, 'inherited prefix is hidden from the side transcript');
        await waitFor(() => desktop.window.webContents.executeJavaScript("!document.querySelector('#side-messages .transcript-skeleton')"), 5000, 'the initial temporary history read settles');
        assertEqual(await desktop.window.webContents.executeJavaScript("document.querySelectorAll('#side-messages [role=\"alert\"]').length"), 0, 'an empty temporary conversation has no saved-history failure');
        const engineId = await desktop.sessions.resolveLiveSession(sideId);
        const done = await doneCount(sideId);
        await desktop.window.webContents.executeJavaScript(`(() => { const input = document.getElementById('side-input'); input.value = 'PLAIN FIXTURE from the actual side composer'; input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
        await waitFor(() => desktop.window.webContents.executeJavaScript("!document.getElementById('side-send').disabled"), 3000, 'side submit button enabled');
        composerBefore = await desktop.window.webContents.executeJavaScript(`({value:document.getElementById('side-input').value,active:window.klausSideSurfaceSessionId?.(),task:window.KlausSideTasks.getActiveSideId(),model:document.getElementById('side-model-select')?.innerText,button:document.getElementById('side-send').outerHTML})`);
        await desktop.window.webContents.executeJavaScript("document.getElementById('side-send').click()");
        await waitFor(async () => await doneCount(sideId!) > done, 15000, 'side composer submitted a real engine turn');
        await waitFor(() => desktop.window.webContents.executeJavaScript("document.getElementById('side-messages').innerText.includes('Fixture response complete.')"), 10000, 'actual shared side surface renders the answer');
        assertEqual(await desktop.window.webContents.executeJavaScript("document.querySelectorAll('#side-messages [role=\"alert\"]').length"), 0, 'completed temporary history remains readable without a saved rollout');
        assertEqual(await desktop.window.webContents.executeJavaScript("document.querySelectorAll('#side-messages .msg.user').length"), 1, 'live history handoff retains one copy of the submitted user message');
        const deltas = (await records()).filter(record => record.channel === 'chat:event:batch').flatMap(record => record.value as Array<{type:string;sessionId:string;text?:string}>);
        assert(deltas.filter(event => event.sessionId === sideId && event.type === 'text_delta' && event.text).length >= 2, 'multiple side-task deltas reach the normal renderer stream');
        const request = provider!.requests.find(request => JSON.stringify(request.messages).includes('PLAIN FIXTURE from the actual side composer'));
        assert(request && JSON.stringify(request.messages).includes('inherited side-task context one')
          && JSON.stringify(request.messages).includes('inherited side-task context two'), 'actual provider sees the completed parent context prefix');
        await desktop.sessions.request('config/batchWrite', {edits:[{keyPath:'modelProviders.sideTaskFixture',mergeStrategy:'replace',value:{name:'Side fixture',provider:'anthropic',model:'side-fixture-model',baseUrl:provider!.url,maxContextTokens:160000,thinking:'off'}}]});
        await desktop.sessions.request('model/credential/write', {id:'sideTaskFixture',apiKey:'side-fixture-key'});
        await invoke('session:set-main-model', {sessionId:sideId,mode:'custom:sideTaskFixture',source:'custom'});
        await turn(sideId, 'PLAIN FIXTURE side-task model changed');
        assertEqual(await desktop.sessions.resolveLiveSession(sideId), engineId, 'model switch preserves the ephemeral endpoint');
        const changed = provider!.requests.find(request => JSON.stringify(request.messages).includes('PLAIN FIXTURE side-task model changed'));
        assert(changed?.model === 'side-fixture-model' && JSON.stringify(changed.messages).includes('inherited side-task context two')
          && JSON.stringify(changed.messages).includes('inherited side-task context one'), 'new model retains the completed parent context prefix');
        const sideHistory = JSON.stringify(await invoke('session:history', {sessionId:sideId}));
        const promoted = await invoke('session:fork', {sessionId:sideId}) as {id:string}; branchId = promoted.id;
        const branchHistory = JSON.stringify(await invoke('session:history', {sessionId:branchId}));
        assert(branchHistory.includes('inherited side-task context one') && branchHistory.includes('inherited side-task context two')
          && branchHistory.includes('from the actual side composer') && branchHistory.includes('side-task model changed'), 'promotion reveals and persists inherited prefix plus side turns');
        assertEqual(JSON.stringify(await invoke('session:history', {sessionId:sideId})), sideHistory, 'promotion preserves the open source');
        assertEqual(JSON.stringify(await invoke('session:history', {sessionId:parent.id})), parentHistory, 'side turns and promotion do not alter the parent');
        await invoke('session:archive', {sessionId:branchId}); await invoke('session:unarchive', {sessionId:branchId});
        assertEqual(JSON.stringify(await invoke('session:history', {sessionId:branchId})), branchHistory, 'promoted history survives real close and disk resume');
        const files = readdirSync(root, {recursive:true}).map(String);
        assert(files.some(path => path.endsWith(`-${branchId}.jsonl`)), 'promoted destination has a physical rollout');
        assert(!files.some(path => path.endsWith(`-${sideId}.jsonl`)), 'ephemeral source has no physical rollout');
        assert(!(await invoke('session:list') as Array<{id:string}>).some(row => row.id === sideId), 'ephemeral task is absent from the normal sidebar');
        await desktop.window.webContents.executeJavaScript(`window.KlausSideTasks.closeById(${JSON.stringify(sideId)})`);
        await assertRejects(() => desktop.sessions.resolveLiveSession(sideId!), 'closed source cannot resume');
        assertEqual((await invoke('side-task:list', {parentSessionId:parent.id}) as unknown[]).length, 0, 'real close removes side family row');
        sideId = undefined;
      } catch (error) {
        writeFileSync(join(__dirname, 'side-tasks-gui-debug.json'), JSON.stringify({at:new Date().toISOString(),parent,sideId,branchId,composerBefore,error:String(error),engine:engineEvents.slice(-75),renderer:await records(),provider:provider!.requests.slice(-4),ui:await desktop.window.webContents.executeJavaScript(`({value:document.getElementById('side-input')?.value,active:window.klausSideSurfaceSessionId?.(),task:window.KlausSideTasks.getActiveSideId(),text:document.body.innerText.slice(-16000)})`)}, null, 2));
        throw error;
      } finally {
        await invoke('session:set-main-model', {mode:defaults.mode,source:defaults.source});
        if (sideId && desktop.sessions.isSideTask(sideId)) await invoke('side-task:close', {sessionId:sideId});
        if (branchId) await invoke('session:delete', {sessionId:branchId});
        await invoke('session:delete', {sessionId:parent.id});
        await desktop.sessions.request('model/credential/delete', {id:'sideTaskFixture'});
        await desktop.sessions.request('config/batchWrite', {edits:[{keyPath:'modelProviders.sideTaskFixture',mergeStrategy:'replace',value:null}]});
      }
    });
    await h.test('the actual SSH modal authenticates, browses and selects a native remote directory', async () => {
      await desktop.window.webContents.executeJavaScript(`void (() => { window.__sshModalResult = undefined; window.openSshConnectModal().then(result => { window.__sshModalResult = result; }); })()`);
      await waitFor(() => desktop.window.webContents.executeJavaScript(`Boolean(document.querySelector('#ssh-hosts [data-host="gui-fixture"]'))`), 10000, 'native SSH config alias reaches the actual dialog');
      await desktop.window.webContents.executeJavaScript(`document.querySelector('#ssh-hosts [data-host="gui-fixture"]').click()`);
      await waitFor(() => desktop.window.webContents.executeJavaScript(`Boolean(document.querySelector('#ssh-askpass:not([hidden]) .ssh-askpass-input'))`), 10000, 'native authentication prompt is visible');
      assertEqual(await desktop.window.webContents.executeJavaScript(`document.querySelector('.ssh-askpass-input').type`), 'password', 'secret input remains concealed');
      await desktop.window.webContents.executeJavaScript(`document.querySelector('.ssh-askpass-input').value='fixture-password'; document.querySelector('[data-ap-ok]').click()`);
      await waitFor(() => desktop.window.webContents.executeJavaScript(`Boolean(document.querySelector('#ssh-dirs [data-dir="plain"]'))`), 10000, 'real SSH command returned remote directories');
      assert((await desktop.window.webContents.executeJavaScript(`document.getElementById('ssh-dirs').textContent`) as string).includes("quote'"), 'special remote names reach the dialog');
      await desktop.window.webContents.executeJavaScript(`document.getElementById('ssh-use-dir').click()`);
      await waitFor(() => desktop.window.webContents.executeJavaScript('Boolean(window.__sshModalResult)'), 5000, 'native remote workdir was selected');
      assertEqual((await desktop.window.webContents.executeJavaScript('window.__sshModalResult') as {workdir:string}).workdir, 'ssh://gui-fixture/fixture home', 'selected alias and remote path are preserved');
    });
    await h.test('workspace files, multi-folder search and a restricted preview work through production IPC', async () => {
      const primary = join(root, 'file-primary'), secondary = join(root, 'file-secondary');
      mkdirSync(primary); mkdirSync(secondary);
      const picture = join(primary, 'fixture.png'), document = join(primary, 'notes.md');
      writeFileSync(picture, Buffer.from(PNG_FIXTURE_BASE64, 'base64'));
      writeFileSync(document, '# Workspace fixture'); writeFileSync(join(secondary, 'secondary-needle.txt'), 'secondary');
      const group = await invoke('workspaces:save', { name: 'Fixture workspace', roots: [primary, secondary] }) as { id: string };
      const row = await invoke('session:new', { workspaceId: group.id }) as { id: string; workspaceId: string; workdir: string };
      assertEqual(row.workspaceId, group.id, 'new session carries group');
      assertEqual(row.workdir, primary, 'engine starts in primary workspace');
      const listed = await invoke('workspace:list', { sessionId: row.id }) as { root: string; tree: Array<{name:string}> };
      assertEqual(listed.root, primary, 'actual file-panel root');
      assert(listed.tree.some(file => file.name === 'notes.md'), 'file panel sees disk contents');
      const hits = await invoke('engine:workspaceFileSearch', { sessionId: row.id, query: 'secondary-needle', limit: 20 }) as Array<{rel:string}>;
      assert(hits.some(hit => hit.rel.includes('secondary-needle')), 'native search includes the other workspace root');
      assertEqual((await invoke('workspace:write', { sessionId: row.id, filePath: document, content: '# Updated' }) as {ok:boolean}).ok, true, 'editor writes existing file');
      const url = (await invoke('artifacts:file-url', { sessionId: row.id, filePath: picture }) as {url:string}).url;
      const range = await desktop.window.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}, {headers:{Range:'bytes=0-7'}}).then(async r=>({status:r.status,bytes:Array.from(new Uint8Array(await r.arrayBuffer()))}))`) as {status:number;bytes:number[]};
      assertEqual(range.status, 206, 'Chromium requests media ranges');
      assertEqual(range.bytes.join(','), '137,80,78,71,13,10,26,10', 'exact PNG header through capability URL');
      assertEqual((await invoke('artifacts:open-window', { sessionId: row.id, filePath: picture }) as {ok:boolean}).ok, true, 'preview opened');
      const preview = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('artifact.html'));
      assert(preview, 'separate artifact window exists');
      await waitFor(() => preview.webContents.executeJavaScript("Boolean(document.querySelector('#aw-body img')?.naturalWidth)"), 10000, 'actual image renders in preview');
      assertEqual(await preview.webContents.executeJavaScript('typeof window.klaus.chat'), 'undefined', 'preview bridge contains no chat control');
      await assertRejects(() => preview.webContents.executeJavaScript(`window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke', {channel:'chat:send',args:[{sessionId:${JSON.stringify(row.id)},text:'refused'}]})`), 'main rejects a forged preview capability');
      preview.destroy();
      await invoke('session:set-workdir', { sessionId: row.id, dir: secondary });
      assertEqual(await desktop.window.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}).then(r=>r.status)`), 404, 'changing workspace revokes old media access');
      await invoke('session:delete', { sessionId: row.id });
    });
    await h.test('memory previews and the actual Spec panel read scoped documents and export exact content', async () => {
      const memory = join(root, 'agent-memory/gui-memory.md'), spec = join(root, 'plans/gui-spec.md');
      mkdirSync(join(root, 'agent-memory'), { recursive: true }); mkdirSync(join(root, 'plans'), { recursive: true });
      writeFileSync(memory, '# Memory fixture\nA visible memory preview.\n');
      const content = '# GUI Spec\n\nExact exported content.\n'; writeFileSync(spec, content);
      assertEqual((await desktop.window.webContents.executeJavaScript(`window.klaus.memory.openWindow(${JSON.stringify(memory)})`) as {ok:boolean}).ok, true, 'main bridge opens memory');
      const preview = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('kind=memory'));
      assert(preview, 'memory uses the restricted preview window');
      try {
        await waitFor(() => preview.webContents.executeJavaScript(`document.getElementById('aw-body')?.textContent.includes('A visible memory preview.')`), 10000, 'memory preview reads through its real filePath bridge');
        assertEqual(await preview.webContents.executeJavaScript('typeof window.klaus.session'), 'undefined', 'memory preview has no session controls');
      } finally { preview.destroy(); }
      const row = await invoke('session:new') as {id:string};
      try {
        await desktop.window.webContents.executeJavaScript(`window.switchSession(${JSON.stringify(row.id)})`);
        await desktop.window.webContents.executeJavaScript(`window.openSpecPanel(${JSON.stringify({sessionId:row.id,path:spec})})`);
        await waitFor(() => desktop.window.webContents.executeJavaScript(`document.querySelector('#spec-panel .spec-document-view:not([hidden]) .spec-document-content')?.textContent.includes('Exact exported content.')`), 10000, 'real Spec panel displays read content');
        await desktop.window.webContents.executeJavaScript(`document.querySelector('#spec-panel [data-spec-action="download"]').click()`);
        await waitFor(() => existsSync(specExportedPath), 10000, 'panel export reaches selected save path');
        assertEqual(readFileSync(specExportedPath, 'utf8'), content, 'export preserves exact complete document');
      } finally { await invoke('session:delete', {sessionId:row.id}); }
    });
    await h.test('session titles, pins and archive state persist through the actual lifecycle', async () => {
      const row = await invoke('session:new') as { id: string };
      await invoke('session:rename', { sessionId: row.id, title: 'Lifecycle fixture' });
      const pin = await invoke('session:set-pinned', { sessionId: row.id, pinned: true }) as {ok:boolean;sidebarPinnedAt:number};
      assert(pin.ok && typeof pin.sidebarPinnedAt === 'number', 'pin acknowledged');
      let stored = await desktop.sessions.threadRow(row.id);
      assertEqual(stored.title, 'Lifecycle fixture', 'title persisted');
      assertEqual((stored.hostMetadata as {sidebarPinnedAt:number}).sidebarPinnedAt, pin.sidebarPinnedAt, 'pin persisted');
      assertEqual((await invoke('session:list') as Array<{id:string;sidebarPinnedAt?:number}>).find(item => item.id === row.id)?.sidebarPinnedAt, pin.sidebarPinnedAt, 'sidebar receives its pin field');
      const archive = await invoke('session:archive', { sessionId: row.id, displayTitle: 'Archived fixture' }) as {ok:boolean};
      assertEqual(archive.ok, true, 'archive acknowledged');
      assert((await invoke('session:list-archived') as Array<{id:string}>).some(item => item.id === row.id), 'archived list includes actual thread');
      await invoke('session:rename', { sessionId: row.id, title: 'Renamed while archived' });
      await invoke('session:set-pinned', { sessionId: row.id, pinned: false });
      assertEqual((await invoke('session:unarchive', { sessionId: row.id }) as {ok:boolean}).ok, true, 'restore acknowledged');
      stored = await desktop.sessions.threadRow(row.id);
      assertEqual(stored.title, 'Renamed while archived', 'historical rename persisted');
      assertEqual((stored.hostMetadata as {sidebarPinnedAt?:number} | undefined)?.sidebarPinnedAt, undefined, 'unpin preserved through restore');
      await invoke('session:history', { sessionId: row.id });
      await invoke('session:delete', { sessionId: row.id });
      await assertRejects(() => invoke('session:history', { sessionId: row.id }), 'deleted identity cannot be reopened');
    });
    await h.test('sidebar section and project collapse survive a real reload from settings.db', async () => {
      // The defect this pins: group fold state used to live only in renderer
      // memory, so every refresh snapped all projects back open. It now persists
      // as two settings.db rows via the shared settings:kv channel.
      const project = join(root, 'sidebar-collapse-project'); mkdirSync(project, { recursive: true });
      const row = await invoke('session:new', { workdir: project }) as { id: string };
      await desktop.sessions.resolveLiveSession(row.id);
      await invoke('session:rename', { sessionId: row.id, title: 'Sidebar collapse fixture' });
      const js = (source: string) => desktop.window.webContents.executeJavaScript(source);
      try {
        // Fold the Recent section through its real toggle button.
        const before = await js(`(() => {
          const heads = Array.from(document.querySelectorAll('#session-list [aria-expanded]'));
          return heads.map(head => ({ label: head.textContent.trim(), expanded: head.getAttribute('aria-expanded') }));
        })()`) as Array<{ label: string; expanded: string }>;
        assert(before.some(head => head.expanded === 'true'), 'section heads start expanded');
        await js(`(() => {
          const head = Array.from(document.querySelectorAll('#session-list button[aria-expanded]'))
            .find(candidate => candidate.textContent.trim() === '最近任务' || candidate.textContent.trim() === 'Recent');
          if (!head) throw new Error('the Recent section head is missing');
          head.click();
        })()`);
        await waitFor(() => js(`(() => {
          const head = Array.from(document.querySelectorAll('#session-list button[aria-expanded]'))
            .find(candidate => candidate.textContent.trim() === '最近任务' || candidate.textContent.trim() === 'Recent');
          return head?.getAttribute('aria-expanded') === 'false';
        })()`), 10000, 'clicking the section head folds it');

        // The write is fire-and-forget, so wait for the authoritative row to land.
        await waitFor(async () => {
          const raw = await invoke('settings:kv:get', { key: 'sidebar.sections_collapsed' }) as string | null;
          return !!raw && JSON.parse(raw).recent === true;
        }, 10000, 'the section fold reached settings.db');

        // Fold the project group too, by clicking its row (not its action buttons).
        await js(`(() => {
          const group = Array.from(document.querySelectorAll('#session-list [data-project-key]'))
            .find(candidate => candidate.getAttribute('aria-expanded') === 'true');
          if (!group) throw new Error('no expanded project group is rendered');
          group.click();
        })()`);
        await waitFor(async () => {
          const raw = await invoke('settings:kv:get', { key: 'sidebar.project_expanded' }) as string | null;
          return !!raw && Object.values(JSON.parse(raw) as Record<string, boolean>).some(value => value === false);
        }, 10000, 'the project fold reached settings.db');

        // A folded group drops its rows from the DOM entirely.
        await waitFor(() => js(`!document.querySelector('#session-list [data-project-key] + div [tabindex="0"]') || Array.from(document.querySelectorAll('#session-list [data-project-key]')).some(group => group.getAttribute('aria-expanded') === 'false')`), 10000, 'a folded group renders no thread rows');

        // Reload the real page: the renderer must restore both folds from the host.
        await desktop.window.webContents.loadURL(desktop.window.webContents.getURL());
        // The reload destroys the page-scoped recorder; later tests read
        // `records()`, so restore it before asserting anything.
        await waitFor(() => js('Boolean(window.klaus && window.__KLAUS_DESKTOP__)'), 15000, 'the reloaded page re-exposed its bridge');
        await installFixtureEventRecorder();
        await waitFor(() => js(`(() => {
          const boot = document.getElementById('boot-screen');
          return (!boot || getComputedStyle(boot).display === 'none')
                        && document.querySelectorAll('#session-list [aria-expanded]').length > 0;
        })()`), 20000, 'the sidebar re-rendered after reload');
        await waitFor(() => js(`(() => {
          const head = Array.from(document.querySelectorAll('#session-list button[aria-expanded]'))
            .find(candidate => candidate.textContent.trim() === '最近任务' || candidate.textContent.trim() === 'Recent');
          const group = Array.from(document.querySelectorAll('#session-list [data-project-key]'))
            .find(candidate => candidate.getAttribute('aria-expanded') === 'false');
          return head?.getAttribute('aria-expanded') === 'false' && !!group;
        })()`), 15000, 'both folds survive a reload');

        // Neither row is an engine config row, so neither can reach the model config.
        assertEqual(await invoke('settings:kv:get', { key: 'sidebar.sections_collapsed' }) !== null, true, 'the section row is a host settings row');
        const engineRows = await invoke('settings:models:list') as Array<{ id: string }>;
        assert(Array.isArray(engineRows), 'the model catalog still reads independently of the sidebar rows');
      } finally {
        await invoke('session:delete', { sessionId: row.id });
        await invoke('settings:kv:set', { key: 'sidebar.sections_collapsed', value: '{"pinned":false,"channels":false,"projects":false,"recent":false}' });
        await invoke('settings:kv:set', { key: 'sidebar.project_expanded', value: '{}' });
        await invoke('projects:remove', { path: project });
        await desktop.window.webContents.loadURL(desktop.window.webContents.getURL());
        await waitFor(() => js('Boolean(window.klaus && window.__KLAUS_DESKTOP__)'), 15000, 'sidebar reset reload re-exposed its bridge');
        await installFixtureEventRecorder();
        await waitFor(() => js(`document.querySelectorAll('#session-list button[data-section-toggle][aria-expanded]').length > 0`), 15000, 'sidebar reset re-rendered its section heads');
      }
    });
    await h.test('every rendered sidebar section folds independently through its own head', async () => {
      // WP2 requires all four sections to be foldable. The previous test drives
      // Recent only; this one walks every head that actually rendered, so a
      // section wired with the wrong sectionKey cannot pass by hiding behind the
      // shared code path. Channels needs a channel session to render at all, so
      // the loop covers whichever sections are present.
      const project = join(root, 'sidebar-sections-project'); mkdirSync(project, { recursive: true });
      await invoke('projects:add', { path: project });
      const js = (source: string) => desktop.window.webContents.executeJavaScript(source);
      const bound = await invoke('session:new', { workdir: project }) as { id: string };
      const loose = await invoke('session:new') as { id: string };
      const pinned = await invoke('session:new') as { id: string };
      const headNames = () => js(`Array.from(document.querySelectorAll('#session-list button[data-section-toggle][aria-expanded]')).map(head => head.textContent.trim())`) as Promise<string[]>;
      const expandedOf = (name: string) => js(`(() => {
        const head = Array.from(document.querySelectorAll('#session-list button[data-section-toggle][aria-expanded]')).find(candidate => candidate.textContent.trim() === ${JSON.stringify(name)});
        return head ? head.getAttribute('aria-expanded') : null;
      })()`) as Promise<string | null>;
      try {
        await desktop.sessions.resolveLiveSession(loose.id);
        await invoke('session:set-pinned', { sessionId: pinned.id, pinned: true });
        // Wait until the pinned, projects and recent heads are all present. The
        // channels section only renders for a channel session, which this fixture
        // does not create, so it is not required here.
        const WANTED = ['置顶任务', 'Pinned', '项目', 'Projects', '最近任务', 'Recent'];
        await waitFor(async () => {
          await js('window.updateSessionInList({ reorder: true })');
          const labels = await headNames();
          return labels.filter(label => WANTED.includes(label)).length >= 3;
        }, 20000, 'the pinned, projects and recent heads all rendered');

        for (let attempt = 0; attempt < 4; attempt++) {
          const collapsed = await js(`(() => {
            const head = Array.from(document.querySelectorAll('#session-list button[data-section-toggle][aria-expanded]'))
              .find(candidate => candidate.getAttribute('aria-expanded') === 'false');
            if (!head) return null;
            const name = head.textContent.trim(); head.click(); return name;
          })()`) as string | null;
          if (!collapsed) break;
          await waitFor(async () => (await expandedOf(collapsed)) === 'true', 10000, 'all section heads start unfolded');
        }
        const names = await headNames();
        const keys = await js(`Array.from(document.querySelectorAll('#session-list button[data-section-toggle][aria-expanded]')).map(head => [head.textContent.trim(), head.getAttribute('data-section-toggle')])`) as Array<[string, string | null]>;
        const keyByName = new Map(keys);
        assert(names.length >= 3, `expected several section heads, got ${names.length}`);
        const folded: string[] = [];
        for (const name of names) {
          // Folding one head must leave the others alone: sections are independent.
          await js(`(() => {
            const head = Array.from(document.querySelectorAll('#session-list button[data-section-toggle][aria-expanded]')).find(candidate => candidate.textContent.trim() === ${JSON.stringify(name)});
            if (!head) throw new Error('the section head disappeared');
            head.click();
          })()`);
          await waitFor(async () => (await expandedOf(name)) === 'false', 10000, `the ${name} section folded`);
          folded.push(name);
          for (const other of names) {
            if (other === name) continue;
            const expected = folded.includes(other) ? 'false' : 'true';
            assertEqual(await expandedOf(other), expected, `folding ${name} left ${other} at its own state`);
          }
        }

        // Every fold reached the single persisted sections row.
        const foldedKeys = folded.map(name => keyByName.get(name));
        assert(foldedKeys.every(Boolean), 'every rendered section exposes its stable persistence key: ' + JSON.stringify({ keys, folded }));
        await waitFor(async () => {
          const raw = await invoke('settings:kv:get', { key: 'sidebar.sections_collapsed' }) as string | null;
          if (!raw) return false;
          const state = JSON.parse(raw) as Record<string, boolean>;
          return foldedKeys.every(key => state[key!] === true);
        }, 10000, 'each rendered section fold is recorded in settings.db');
        const finalState = JSON.parse(String(await invoke('settings:kv:get', { key: 'sidebar.sections_collapsed' }))) as Record<string, boolean>;
        assertEqual(Object.keys(finalState).sort().join(','), 'channels,pinned,projects,recent', 'the row carries exactly the four section keys');
      } finally {
        for (const row of [bound, loose, pinned]) await invoke('session:delete', { sessionId: row.id });
        await invoke('settings:kv:set', { key: 'sidebar.sections_collapsed', value: '{"pinned":false,"channels":false,"projects":false,"recent":false}' });
        // Reset the in-memory renderer state through its own controls as well as
        // the persisted row, so the next test does not inherit a folded section.
        for (let attempt = 0; attempt < 4; attempt++) {
          const clicked = await js(`(() => {
            const head = Array.from(document.querySelectorAll('#session-list button[data-section-toggle][aria-expanded]'))
              .find(candidate => candidate.getAttribute('aria-expanded') === 'false');
            if (!head) return null;
            const name = head.textContent.trim(); head.click(); return name;
          })()`) as string | null;
          if (!clicked) break;
          await waitFor(async () => (await expandedOf(clicked)) !== 'false', 10000, 'section fold reset committed in the renderer');
        }
        await waitFor(async () => {
          const states = await js(`Array.from(document.querySelectorAll('#session-list button[data-section-toggle][aria-expanded]')).map(head => head.getAttribute('aria-expanded'))`) as string[];
          return states.every(state => state === 'true');
        }, 10000, 'the renderer restored every section before the next test ran');
        await invoke('projects:remove', { path: project });
      }
    });
    await h.test('section chevrons render and rotate with fold state in the real browser', async () => {
      // The disclosure stays hidden until hover/focus but is forced visible
      // and rotated -90deg while collapsed. That is computed style, which only a
      // real browser can settle, so it is asserted here rather than in CSS source.
      const project = join(root, 'sidebar-chevron-project'); mkdirSync(project, { recursive: true });
      await invoke('projects:add', { path: project });
      const created = await invoke('session:new', { workdir: project }) as { id: string };
      // The Recent section renders nothing when it has no projectless session, and
      // this test drives that specific head, so it needs one row of its own.
      const projectless = await invoke('session:new') as { id: string };
      const js = (source: string) => desktop.window.webContents.executeJavaScript(source);
      const chevronStyle = () => js(`(() => {
        const head = Array.from(document.querySelectorAll('#session-list button[aria-expanded]'))
          .find(candidate => candidate.textContent.trim() === '最近任务' || candidate.textContent.trim() === 'Recent');
        if (!head) throw new Error('the Recent section head is missing');
        const chevron = head.querySelector('span[aria-hidden="true"]');
        if (!chevron) throw new Error('the section head has no chevron element');
        const style = getComputedStyle(chevron);
        return { opacity: style.opacity, transform: style.transform, ariaExpanded: head.getAttribute('aria-expanded') };
      })()`) as Promise<{ opacity: string; transform: string; ariaExpanded: string }>;
      try {
        await desktop.sessions.resolveLiveSession(created.id);
        // Wait for the Recent head specifically; any other section head would
        // satisfy a bare aria-expanded query without the row this test drives.
        await waitFor(async () => {
          await js('window.updateSessionInList({ reorder: true })');
          return await js(`Array.from(document.querySelectorAll('#session-list button[aria-expanded]')).some(candidate => ['最近任务','Recent'].includes(candidate.textContent.trim()))`);
        }, 20000, 'the Recent section head rendered');

        const expanded = await chevronStyle();
        assertEqual(expanded.ariaExpanded, 'true', 'the section starts expanded');
        assert(expanded.transform === 'none' || expanded.transform.includes('matrix(1, 0, 0, 1'), `an expanded chevron is not rotated, got ${expanded.transform}`);

        // The chevron must sit to the RIGHT of the label text. A
        // chevron before the label (or one reserving width while hidden) makes
        // every section head read as indented relative to the nav rows above.
        const geometry = await js(`(() => {
          const head = Array.from(document.querySelectorAll('#session-list button[aria-expanded]'))
            .find(candidate => candidate.textContent.trim() === '最近任务' || candidate.textContent.trim() === 'Recent');
          const label = head.querySelector('span:not([aria-hidden])');
          const chevron = head.querySelector('span[aria-hidden="true"]');
          if (!label || !chevron) throw new Error('label or chevron span missing in the section head');
          const labelBox = label.getBoundingClientRect();
          const chevronBox = chevron.getBoundingClientRect();
          const headBox = head.getBoundingClientRect();
          return { labelLeft: labelBox.left, chevronLeft: chevronBox.left, headLeft: headBox.left };
        })()`) as { labelLeft: number; chevronLeft: number; headLeft: number };
        assert(geometry.chevronLeft >= geometry.labelLeft, `the chevron sits right of the label, got chevron ${geometry.chevronLeft} vs label ${geometry.labelLeft}`);
        // The label must start at the head's own left inset — no hidden chevron
        // pushing it right.
        assert(Math.abs(geometry.labelLeft - geometry.headLeft) <= 12, `the label starts at the head inset, got label ${geometry.labelLeft} vs head ${geometry.headLeft}`);

        // The hover-reveal half of the contract is checked in the stylesheet, not
        // through getComputedStyle: in a real window the OS cursor may sit over the
        // sidebar, so a runtime "unhovered" opacity read is mouse-position dependent
        // rather than a property of this code. The rule is opacity-0 until
        // hover/focus, forced to 1 while collapsed — pinned from the CSSOM instead.
        const chevronOpacityRules = await js(`(() => {
          const out = [];
          for (const sheet of document.styleSheets) {
            let rules;
            try { rules = sheet.cssRules } catch { continue }
            for (const rule of rules) {
              const sel = rule.selectorText || '';
              // The chevron's base rule names only the chevron class; the
              // reveal/force rules name the toggle as the ancestor.
              if (!sel.includes('sidebar-section-chevron') && !sel.includes('sidebar-section-toggle')) continue;
              out.push({ selector: sel, opacity: rule.style.opacity || null });
            }
          }
          return out;
        })()`) as Array<{ selector: string; opacity: string | null }>;
        const baseRule = chevronOpacityRules.find(row => row.selector.includes('sidebar-section-chevron') && !row.selector.includes(':hover') && !row.selector.includes('is-collapsed'));
        assert(!!baseRule && baseRule.opacity === '0', `the chevron is hidden by default, rules were ${JSON.stringify(chevronOpacityRules)}`);
        assert(chevronOpacityRules.some(row => row.selector.includes('sidebar-section-chevron') && row.selector.includes(':hover') && row.opacity === '1'), 'hover reveals the chevron');
        assert(chevronOpacityRules.some(row => row.selector.includes('sidebar-section-chevron') && row.selector.includes('is-collapsed') && row.opacity === '1'), 'a collapsed section forces the chevron visible');

        await js(`(() => {
          const head = Array.from(document.querySelectorAll('#session-list button[aria-expanded]'))
            .find(candidate => candidate.textContent.trim() === '最近任务' || candidate.textContent.trim() === 'Recent');
          head.click();
        })()`);
        // Poll the transform itself: aria-expanded flips immediately while the
        // 0.15s CSS transition is still running, so reading it right after the
        // flip would sample a mid-animation matrix.
        await waitFor(async () => (await chevronStyle()).transform.includes('matrix(0, -1, 1, 0'), 10000, 'the collapsed chevron finished rotating -90deg');
        const collapsed = await chevronStyle();
        assertEqual(collapsed.ariaExpanded, 'false', 'the section is folded');
        // Forced visible while collapsed, and rotated -90deg (matrix(0,-1,1,0,...)).
        assertEqual(collapsed.opacity, '1', 'a collapsed chevron stays visible without hover');
        assert(collapsed.transform.includes('matrix(0, -1, 1, 0'), `a collapsed chevron is rotated -90deg, got ${collapsed.transform}`);
      } finally {
        await invoke('session:delete', { sessionId: created.id });
        await invoke('session:delete', { sessionId: projectless.id });
        await invoke('settings:kv:set', { key: 'sidebar.sections_collapsed', value: '{"pinned":false,"channels":false,"projects":false,"recent":false}' });
        await invoke('projects:remove', { path: project });
      }
    });
    await h.test('project show-more steps 5 then +10 per press, has no show-less, and resets on fold', async () => {
      // Pagination: preview 5, then +10 per press (5 → 15 → 25 → …), with no
      // show-less inside a group. This needs a real click sequence, so the pure
      // formula in collapse.ts is pinned end to end here. 26 sessions make the
      // first three windows (5, 15, 25) each strictly smaller than the total, so
      // every step is observable and the fourth press finally reveals the rest.
      const project = join(root, 'sidebar-pagination-project'); mkdirSync(project, { recursive: true });
      await invoke('projects:add', { path: project });
      const created: string[] = [];
      const js = (source: string) => desktop.window.webContents.executeJavaScript(source);
      // Scoped to this project's own key so groups other tests left behind cannot
      // be counted. The thread list div carries data-project-key and its rows are
      // its direct children, so `>` excludes the project row itself.
      const key = JSON.stringify(project);
      const countThreads = () => js(`document.querySelectorAll(\`#session-list [data-project-key=${key}] > [tabindex="0"]\`).length`) as Promise<number>;
      const findMore = () => js(`Boolean(Array.from(document.querySelectorAll('#session-list button')).find(button => ['展开显示','Show more'].includes(button.textContent.trim())))`) as Promise<boolean>;
      const pressMore = () => js(`(() => {
        const button = Array.from(document.querySelectorAll('#session-list button'))
          .find(candidate => ['展开显示','Show more'].includes(candidate.textContent.trim()));
        if (!button) throw new Error('the show-more button is missing');
        button.click();
      })()`);
      try {
        for (let index = 0; index < 26; index += 1) {
          const made = await invoke('session:new', { workdir: project }) as { id: string };
          created.push(made.id);
        }
        await desktop.sessions.resolveLiveSession(created[0]!);
        // updateSessionInList is async and not exported, so poll for its result.
        await waitFor(async () => { await js('window.updateSessionInList({ reorder: true })'); return (await countThreads()) === 5; }, 30000, 'the group previews exactly five of its twenty-six rows');

        // Each press adds exactly ten: 5 → 15 → 25, then the final press reveals all 26.
        for (const expected of [15, 25]) {
          assertEqual(await findMore(), true, `more rows remain before reaching ${expected}`);
          await pressMore();
          await waitFor(async () => (await countThreads()) === expected, 10000, `one press reveals ten more rows, reaching ${expected}`);
        }
        assertEqual(await findMore(), true, 'a twenty-sixth row is still beyond the 25-row window');
        await pressMore();
        await waitFor(async () => (await countThreads()) === 26, 10000, 'the last press reveals the remaining row');
        assertEqual(await findMore(), false, 'the button disappears once nothing remains');

        // A project group offers no show-less control.
        const showLess = await js(`Boolean(Array.from(document.querySelectorAll('#session-list button')).find(button => ['收起显示','Show less'].includes(button.textContent.trim())))`) as boolean;
        assertEqual(showLess, false, 'a project group offers no show-less');

        // Folding the group resets its page, so a reopen is back at the preview
        // limit rather than the deep page it had reached.
        await js(`document.querySelector(\`#session-list [data-project-key=${key}]\`).click()`);
        await waitFor(async () => (await countThreads()) === 0, 10000, 'folding hides every thread row');
        await js(`document.querySelector(\`#session-list [data-project-key=${key}]\`).click()`);
        await waitFor(async () => (await countThreads()) === 5, 10000, 'reopening starts back at the five-row preview');
      } finally {
        for (const id of created) await invoke('session:delete', { sessionId: id });
        await invoke('settings:kv:set', { key: 'sidebar.project_expanded', value: '{}' });
        await invoke('projects:remove', { path: project });
      }
    });
    await h.test('an upgrade keeps a pre-rework section fold on its first launch', async () => {
      // Before sections were foldable, `klaus_projects_collapsed` recorded the same
      // choice. A user upgrading must not lose it: with no KV row and no mirror yet,
      // the renderer seeds from the legacy flag and writes it back. This is the
      // first-launch path, so the KV row and the mirror are both removed first.
      const project = join(root, 'sidebar-upgrade-seed'); mkdirSync(project, { recursive: true });
      await invoke('projects:add', { path: project });
      const js = (source: string) => desktop.window.webContents.executeJavaScript(source);
      const created = await invoke('session:new', { workdir: project }) as { id: string };
      const key = JSON.stringify(project);
      const projectsHeadExpanded = () => js(`(() => {
        const head = Array.from(document.querySelectorAll('#session-list button[aria-expanded]'))
          .find(candidate => ['项目','Projects'].includes(candidate.textContent.trim()));
        return head ? head.getAttribute('aria-expanded') : null;
      })()`) as Promise<string | null>;
      try {
        await desktop.sessions.resolveLiveSession(created.id);
        await waitFor(async () => {
          await js('window.updateSessionInList({ reorder: true })');
          return await js(`Boolean(document.querySelector(\`#session-list [data-project-key=${key}]\`))`);
        }, 20000, 'the project group renders before the upgrade is simulated');

        // Simulate the pre-rework state: legacy flag set, new row and mirror absent.
        await js(`(() => {
          localStorage.setItem('klaus_projects_collapsed', '1');
          localStorage.removeItem('klaus_sidebar_sections_collapsed_mirror');
        })()`);
        assertEqual(kvDel('sidebar.sections_collapsed', root), true, 'the section row is removed so this is a first launch');
        assertEqual(await invoke('settings:kv:get', { key: 'sidebar.sections_collapsed' }), null, 'the renderer sees no persisted section row');

        await desktop.window.webContents.loadURL(desktop.window.webContents.getURL());
        await waitFor(() => js('Boolean(window.klaus && window.__KLAUS_DESKTOP__)'), 15000, 'the reloaded page re-exposed its bridge');
        await installFixtureEventRecorder();
        await waitFor(async () => (await projectsHeadExpanded()) === 'false', 20000, 'the legacy projects fold seeded the Projects section');

        // The seeded value is written back, so the next launch reads the new row.
        await waitFor(async () => {
          const raw = await invoke('settings:kv:get', { key: 'sidebar.sections_collapsed' }) as string | null;
          return !!raw && JSON.parse(raw).projects === true;
        }, 10000, 'the seeded fold was persisted to settings.db');
      } finally {
        await js(`localStorage.removeItem('klaus_projects_collapsed')`);
        await invoke('session:delete', { sessionId: created.id });
        await invoke('settings:kv:set', { key: 'sidebar.sections_collapsed', value: '{"pinned":false,"channels":false,"projects":false,"recent":false}' });
        await invoke('projects:remove', { path: project });
        // The reset above is written host-side, so wait for the renderer to catch up
        // through the preferences broadcast before the next test runs.
        await waitFor(async () => (await projectsHeadExpanded()) !== 'false', 15000, 'the renderer restored the sections');
      }
    });
    await h.test('a folded project group surfaces its real session state as an aggregate badge', async () => {
      // The wiring the unit tests cannot reach: live session state → the snapshot's
      // collapsedBadge → the rendered dot. Seeded through the same localStorage
      // key the renderer reads at module scope (klaus_sidebar_completed_sessions),
      // so no engine turn is needed and the badge comes from real state, not a stub.
      const project = join(root, 'sidebar-badge-project'); mkdirSync(project, { recursive: true });
      await invoke('projects:add', { path: project });
      const js = (source: string) => desktop.window.webContents.executeJavaScript(source);
      const created = await invoke('session:new', { workdir: project }) as { id: string };
      const key = JSON.stringify(project);
      const badgeLabel = () => js(`(() => {
        const group = document.querySelector(\`#session-list [data-project-key=${key}]\`);
        const badge = group?.querySelector('[role="status"]');
        return badge ? badge.getAttribute('aria-label') : null;
      })()`) as Promise<string | null>;
      try {
        await desktop.sessions.resolveLiveSession(created.id);
        // Mark the session completed-but-unseen, then reload so the renderer's
        // module-scope Set picks it up exactly as it would after a real turn.
        await js(`localStorage.setItem('klaus_sidebar_completed_sessions', JSON.stringify([${JSON.stringify(created.id)}]))`);
        await desktop.window.webContents.loadURL(desktop.window.webContents.getURL());
        await waitFor(() => js('Boolean(window.klaus && window.__KLAUS_DESKTOP__)'), 15000, 'the reloaded page re-exposed its bridge');
        await installFixtureEventRecorder();
        await waitFor(() => js(`Boolean(document.querySelector(\`#session-list [data-project-key=${key}]\`))`), 20000, 'the project group renders after reload');
        await js('window.updateSessionInList({ reorder: true })');

        // While open there is no aggregate badge; the row carries its own dot.
        assertEqual(await badgeLabel(), null, 'an open group has no aggregate badge');

        await js(`document.querySelector(\`#session-list [data-project-key=${key}]\`).click()`);
        await waitFor(async () => (await badgeLabel()) !== null, 15000, 'folding surfaces the aggregate badge');
        const label = String(await badgeLabel());
        assert(['有待处理项', 'Needs attention'].includes(label), `an unread session in a folded group shows the attention dot, got ${label}`);
        // Badge priority: the badge is a dot, not a spinner, and it is the
        // only status element on that row.
        const statusCount = await js(`document.querySelectorAll(\`#session-list [data-project-key=${key}] [role="status"]\`).length`) as number;
        assertEqual(statusCount, 1, 'the folded group renders exactly one aggregate badge');
      } finally {
        await js(`localStorage.removeItem('klaus_sidebar_completed_sessions')`);
        await invoke('session:delete', { sessionId: created.id });
        await invoke('settings:kv:set', { key: 'sidebar.project_expanded', value: '{}' });
        await invoke('projects:remove', { path: project });
      }
    });
    await h.test('a folded group with a running session shows the spinner, not the dot', async () => {
      // The badge test above proves the `unread` arm (dot). This proves the other
      // arm: a running session inside a folded group renders the spinner.
      //
      // `isWorking` is driven through the session list, which is how the renderer
      // learns a session is busy without an engine turn in this fixture.
      //
      // The E5r priority (unread beats active) needs TWO sessions in the group,
      // not one: `isSidebarSessionCompleteUnread` is defined as
      // `completed && !working`, so a single session can never be both. The rule
      // is therefore observable only across a running session plus a separate
      // completed-unread one, which is what the second half sets up.
      const project = join(root, 'sidebar-spinner-project'); mkdirSync(project, { recursive: true });
      await invoke('projects:add', { path: project });
      const js = (source: string) => desktop.window.webContents.executeJavaScript(source);
      const runner = await invoke('session:new', { workdir: project }) as { id: string };
      const idler = await invoke('session:new', { workdir: project }) as { id: string };
      const key = JSON.stringify(project);
      const badge = () => js(`(() => {
        const group = document.querySelector(\`#session-list [data-project-key=${key}]\`);
        const status = group?.querySelector('[role="status"]');
        if (!status) return null;
        return { label: status.getAttribute('aria-label'), spinner: Boolean(status.querySelector('svg')) };
      })()`) as Promise<{ label: string | null; spinner: boolean } | null>;
      const list = desktop.sessions.listSessions;
      // Mark only `runner` busy; `idler` stays idle so it can carry the unread dot.
      const setRunnerWorking = async (working: boolean) => {
        desktop.sessions.listSessions = async () => {
          const rows = (await list.call(desktop.sessions)) as Json[];
          return rows.map(row => {
            const record = row as JsonObject;
            return record.id === runner.id ? { ...record, isWorking: working } : record;
          });
        };
        await js('window.updateSessionInList({ reorder: true })');
      };
      try {
        await desktop.sessions.resolveLiveSession(runner.id);
        await waitFor(async () => {
          await js('window.updateSessionInList({ reorder: true })');
          return await js(`Boolean(document.querySelector(\`#session-list [data-project-key=${key}]\`))`);
        }, 20000, 'the project group renders');

        await js(`document.querySelector(\`#session-list [data-project-key=${key}]\`).click()`);
        await waitFor(async () => js(`document.querySelector(\`#session-list [data-project-key=${key}]\`)?.getAttribute('aria-expanded') === 'false'`), 10000, 'the group is folded');
        // Folded and idle: nothing needs attention, so no badge at all.
        assertEqual(await badge(), null, 'a folded idle group shows no badge');

        await setRunnerWorking(true);
        await waitFor(async () => (await badge())?.spinner === true, 15000, 'a running session in a folded group shows the spinner');
        const running = await badge();
        assert(['有任务进行中', 'Working'].includes(String(running?.label)), `the spinner carries the working label, got ${running?.label}`);

        // Now also complete-but-unseen the OTHER session. The group holds one
        // running and one unread session, so E5r must resolve to the dot.
        await js(`localStorage.setItem('klaus_sidebar_completed_sessions', JSON.stringify([${JSON.stringify(idler.id)}]))`);
        await desktop.window.webContents.loadURL(desktop.window.webContents.getURL());
        await waitFor(() => js('Boolean(window.klaus && window.__KLAUS_DESKTOP__)'), 15000, 'the reloaded page re-exposed its bridge');
        await installFixtureEventRecorder();
        await setRunnerWorking(true);
        await waitFor(async () => {
          const state = await badge();
          return state?.spinner === false && !!state.label;
        }, 20000, 'an unread session outweighs the running one (E5r priority)');
        const prioritized = await badge();
        assert(['有待处理项', 'Needs attention'].includes(String(prioritized?.label)), `unread wins over running, got ${prioritized?.label}`);
      } finally {
        desktop.sessions.listSessions = list;
        await js(`localStorage.removeItem('klaus_sidebar_completed_sessions')`);
        await invoke('session:delete', { sessionId: runner.id });
        await invoke('session:delete', { sessionId: idler.id });
        await invoke('settings:kv:set', { key: 'sidebar.project_expanded', value: '{}' });
        await invoke('projects:remove', { path: project });
      }
    });
    await h.test('the section head add-project button runs the real project picker', async () => {
      // WP2 adds a hover-only action to the Projects head. It must be reachable,
      // carry a localized aria-label with no tooltip, and be wired to the real
      // registration path rather than rendering as decoration. The OS dialog is
      // stubbed at the bridge seam (`session.pickWorkdir`); everything after it is
      // production code.
      const project = join(root, 'sidebar-addproject-target'); mkdirSync(project, { recursive: true });
      const seedDir = join(root, 'sidebar-addproject-seed'); mkdirSync(seedDir, { recursive: true });
      await invoke('projects:add', { path: seedDir });
      const seed = await invoke('session:new', { workdir: seedDir }) as { id: string };
      const js = (source: string) => desktop.window.webContents.executeJavaScript(source);
      let picks = 0;
      try {
        await desktop.sessions.resolveLiveSession(seed.id);
        await waitFor(async () => {
          await js('window.updateSessionInList({ reorder: true })');
          return await js(`Array.from(document.querySelectorAll('#session-list button[aria-expanded]')).some(head => ['项目','Projects'].includes(head.textContent.trim()))`);
        }, 20000, 'the Projects section head rendered');

        const button = `#session-list button[aria-label="添加项目"], #session-list button[aria-label="Add project"]`;
        assertEqual(await js(`Boolean(document.querySelector(\`${button}\`))`) as boolean, true, 'the head exposes an add-project control');
        assertEqual(await js(`document.querySelector(\`${button}\`)?.getAttribute('title')`) as string | null, null, 'the control carries no tooltip');

        await js(`(() => {
          window.__pickWorkdirOriginal = window.klaus.session.pickWorkdir;
          window.klaus.session.pickWorkdir = async () => { window.__pickCount = (window.__pickCount || 0) + 1; return { path: ${JSON.stringify(project)} }; };
        })()`);
        await js(`document.querySelector(\`${button}\`).click()`);
        await waitFor(() => js(`(window.__pickCount || 0) > 0`), 10000, 'clicking the head control invokes the real project picker');
        // The picker result is registered and revealed as a project group.
        await waitFor(() => js(`Boolean(document.querySelector(\`#session-list [data-project-key=${JSON.stringify(project)}]\`))`), 20000, 'the picked folder became a sidebar project group');
        picks = Number(await js('window.__pickCount || 0'));
        assertEqual(picks, 1, 'the picker ran exactly once for one click');
      } finally {
        await js(`(() => { if (window.__pickWorkdirOriginal) window.klaus.session.pickWorkdir = window.__pickWorkdirOriginal; delete window.__pickCount; delete window.__pickWorkdirOriginal; })()`);
        await invoke('session:delete', { sessionId: seed.id });
        await invoke('projects:remove', { path: project });
        await invoke('projects:remove', { path: seedDir });
        await invoke('settings:kv:set', { key: 'sidebar.project_expanded', value: '{}' });
      }
    });
    await h.test('the workspace editor adds every folder from one multi-select picker run', async () => {
      // The folder row's add button must hand the whole native multi-selection to
      // the editor in one run. The OS dialog is stubbed at the bridge seam
      // (`session.pickWorkdirs`); the modal, its list rendering and its dedupe
      // are production code.
      const first = join(root, 'ws-multi-a'); mkdirSync(first, { recursive: true });
      const second = join(root, 'ws-multi-b'); mkdirSync(second, { recursive: true });
      const js = (source: string) => desktop.window.webContents.executeJavaScript(source);
      try {
        await js(`(() => {
          window.__pickWorkdirsOriginal = window.klaus.session.pickWorkdirs;
          window.__pickWorkdirsCount = 0;
          window.klaus.session.pickWorkdirs = async () => { window.__pickWorkdirsCount += 1; return { paths: ${JSON.stringify([first, second])} }; };
        })()`);
        await js(`document.getElementById('workdir-btn')?.click()`);
        await waitFor(() => js(`Boolean(document.querySelector('[data-project-action="workspace"]'))`), 10000, 'the project picker opened');
        await js(`document.querySelector('[data-project-action="workspace"]').click()`);
        await waitFor(() => js(`Boolean(document.getElementById('ws-add-folder'))`), 10000, 'the workspace editor modal opened');
        await js(`document.getElementById('ws-add-folder').click()`);
        await waitFor(() => js(`(window.__pickWorkdirsCount || 0) > 0`), 10000, 'the add button drives the multi picker');
        await waitFor(() => js(`document.querySelectorAll('.kls-modal [data-ws-remove]').length === 2`), 10000, 'both picked folders joined the selection in one run');
        await js(`(() => { window.klaus.session.pickWorkdirs = async () => { window.__pickWorkdirsCount += 1; return { paths: [] }; }; })()`);
        await js(`document.getElementById('ws-add-folder').click()`);
        await waitFor(() => js(`(window.__pickWorkdirsCount || 0) > 1`), 10000, 'a second click runs the picker again');
        await waitFor(() => js(`document.querySelectorAll('.kls-modal [data-ws-remove]').length === 2`), 5000, 'a cancelled pick keeps the prior selection');
      } finally {
        await js(`(() => { if (window.__pickWorkdirsOriginal) window.klaus.session.pickWorkdirs = window.__pickWorkdirsOriginal; delete window.__pickWorkdirsCount; delete window.__pickWorkdirsOriginal; })()`);
        await js(`document.querySelector('.kls-modal-overlay [data-close]')?.click()`);
      }
    });
    await h.test('starting a draft never pries open a folded group, while opening a real session does', async () => {
      // A client-local thread with no conversationId yet must not
      // expand a group the user explicitly collapsed, but a real session always
      // reveals itself. The production path for the draft half is the project
      // row's own "new chat" button (startProjectNewChat → reveal with draft:true),
      // so this drives the real control rather than poking module state.
      const project = join(root, 'sidebar-draft-reveal'); mkdirSync(project, { recursive: true });
      await invoke('projects:add', { path: project });
      const js = (source: string) => desktop.window.webContents.executeJavaScript(source);
      const created = await invoke('session:new', { workdir: project }) as { id: string };
      // Every selector is scoped to THIS project's key: other tests leave their own
      // groups in the sidebar, so a global "any group" check is not a check.
      const key = JSON.stringify(project);
      const groupExpanded = () => js(`document.querySelector(\`#session-list [data-project-key=${key}]\`)?.getAttribute('aria-expanded') === 'true'`) as Promise<boolean>;
      const persistedExpansion = async () => {
        const raw = await invoke('settings:kv:get', { key: 'sidebar.project_expanded' }) as string | null;
        return raw ? (JSON.parse(raw) as Record<string, boolean>)[project] : undefined;
      };
      try {
        await desktop.sessions.resolveLiveSession(created.id);
        await waitFor(async () => { await js('window.updateSessionInList({ reorder: true })'); return await js(`Boolean(document.querySelector(\`#session-list [data-project-key=${key}]\`))`); }, 20000, 'this project group renders');
        await waitFor(groupExpanded, 15000, 'the group starts expanded');

        await js(`document.querySelector(\`#session-list [data-project-key=${key}]\`).click()`);
        await waitFor(async () => (await persistedExpansion()) === false, 10000, 'the explicit fold reached settings.db');
        assertEqual(await groupExpanded(), false, 'the group is folded');

        // A draft new chat in that folded project must leave it folded.
        await js(`(() => {
          const group = document.querySelector(\`#session-list [data-project-key=${key}]\`);
          const button = group?.querySelector('button[aria-label="在此项目中新建对话"], button[aria-label="New chat in this project"]');
          if (!button) throw new Error('the project row has no new-chat control');
          button.click();
        })()`);
        await new Promise(resolve => setTimeout(resolve, 1200));
        assertEqual(await groupExpanded(), false, 'starting a draft leaves an explicitly folded group folded');
        assertEqual(await persistedExpansion(), false, 'the fold survived the draft in settings.db');

        // Opening the real session in that project must reveal it again.
        await js(`window.switchSession(${JSON.stringify(created.id)})`);
        await waitFor(groupExpanded, 15000, 'opening a real session reveals its group');
        await waitFor(async () => (await persistedExpansion()) === true, 10000, 'the reveal was persisted as an explicit expansion');
      } finally {
        await invoke('session:delete', { sessionId: created.id });
        await invoke('settings:kv:set', { key: 'sidebar.project_expanded', value: '{}' });
        await invoke('projects:remove', { path: project });
      }
    });
    await h.test('actual conversation branches, readonly exports and scoped rewinds preserve their separate effects', async () => {
      const directory = join(root, 'lifecycle-project'), file = join(directory, 'checkpoint.txt');
      mkdirSync(directory); writeFileSync(file, 'before the turn\n');
      for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Klaus fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture base']]) execFileSync('git', args, {cwd:directory,stdio:'ignore'});
      await invoke('settings:kv:set', {key:'klaus.checkpointing',value:'on'});
      const row = await invoke('session:new', {workdir:directory}) as {id:string};
      const turn = async (text:string): Promise<void> => {
        const count = (await records()).filter(record => record.channel === 'chat:event:batch' && (record.value as Array<{type:string;sessionId:string}>).some(event => event.type==='done' && event.sessionId===row.id)).length;
        await invoke('chat:send', {sessionId:row.id,text});
        await waitFor(async () => (await records()).filter(record => record.channel === 'chat:event:batch' && (record.value as Array<{type:string;sessionId:string}>).some(event => event.type==='done' && event.sessionId===row.id)).length > count, 30000, 'lifecycle fixture turn completed');
      };
      await turn('PLAIN FIXTURE first lifecycle turn');
      const history = await invoke('session:history', {sessionId:row.id}) as {messages:Array<{role?:string;uuid?:string;text?:string}>};
      assert(history.messages.some(message => message.text?.includes('first lifecycle turn')), 'first stored user anchor exists');
      await turn('PLAIN FIXTURE second lifecycle turn');
      await invoke('session:rename',{sessionId:row.id,title:'Retained source title'});
      const second = (await invoke('session:history',{sessionId:row.id}) as {messages:Array<{uuid?:string;text?:string}>}).messages.find(message=>message.text?.includes('second lifecycle turn'))?.uuid;
      assert(second,'second stored user anchor exists');
      const full = await invoke('session:fork',{sessionId:row.id}) as {id:string;title:string;workdir:string;forkedFrom:{sessionId:string;title:string}};
      assertEqual(full.title,'Retained source title · Branch','branch title carries the visible branch suffix'); assertEqual(full.workdir,directory,'branch inherits workspace'); assertEqual(full.forkedFrom.sessionId,row.id,'branch provenance is explicit'); assertEqual(full.forkedFrom.title,'Retained source title','branch provenance keeps the raw source title');
      const cut = await invoke('session:fork',{sessionId:row.id,beforeMessageUuid:second}) as {id:string};
      const branchHistory = await invoke('session:history',{sessionId:cut.id}) as {messages:Array<{text?:string}>};
      assert(branchHistory.messages.some(message=>message.text?.includes('first lifecycle turn')) && !branchHistory.messages.some(message=>message.text?.includes('second lifecycle turn')),'branch cut keeps the complete earlier turn only');
      const count = (await invoke('session:list') as unknown[]).length;
      await assertRejects(()=>invoke('session:fork',{sessionId:row.id,beforeMessageUuid:'missing-fixture-anchor'}),'invalid branch cut is rejected');
      assertEqual((await invoke('session:list') as unknown[]).length,count,'failed branch leaves no empty conversation');
      await invoke('session:archive',{sessionId:row.id});
      const requests = provider!.requests.length;
      const exported = await invoke('session:export',{sessionId:row.id}) as {ok:boolean;filePath:string};
      assert(exported.ok && exported.filePath===exportedPath,'IPC exports to the chosen destination');
      const text = readFileSync(exportedPath,'utf8');
      assert(text.includes('first lifecycle turn') && text.includes('second lifecycle turn') && text.includes('Fixture response complete.'),'export contains the complete ordered conversation');
      assertEqual(provider!.requests.length,requests,'cold archived export does not run a model');
      await invoke('session:unarchive',{sessionId:row.id});
      const truncated = await invoke('chat:rewind-from',{sessionId:row.id,messageUuid:second}) as {ok:boolean}; assert(truncated.ok,'conversation truncation reached its actual terminal outcome');
      const remaining = await invoke('session:history',{sessionId:row.id}) as {messages:Array<{text?:string}>};
      assert(!remaining.messages.some(message=>message.text?.includes('second lifecycle turn')),'selected conversation tail removed');
      assert((await invoke('session:history',{sessionId:full.id}) as {messages:Array<{text?:string}>}).messages.some(message=>message.text?.includes('second lifecycle turn')),'independent full branch keeps its inherited tail');
      for (const id of [row.id,full.id,cut.id]) await invoke('session:delete',{sessionId:id});
      await invoke('settings:kv:set',{key:'klaus.checkpointing',value:'off'});
    });
    await h.test('a saved file command expands and runs through the actual engine', async () => {
      const saved = await invoke('commands:save', { name: 'gui-fixture', description: 'Disposable fixture', body: 'PLAIN FIXTURE command $0', scope: 'global' }) as {ok:boolean};
      assert(saved.ok, 'command persisted');
      const listed = await invoke('commands:list', {}) as {commands:Array<{name:string}>};
      assert(listed.commands.some(command => command.name === 'gui-fixture'), 'saved command listed');
      const row = await invoke('session:new') as { id: string };
      await invoke('chat:send', { sessionId: row.id, text: '/gui-fixture argument' });
      await waitFor(async () => (await records()).some(record => record.channel === 'chat:event:batch'
        && (record.value as Array<{type:string;sessionId:string}>).some(event => event.type === 'done' && event.sessionId === row.id)), 30000, 'expanded command completed');
      const history = await invoke('session:history', { sessionId: row.id }) as {messages:Array<{text?:string}>};
      assert(history.messages.some(message => message.text?.includes('PLAIN FIXTURE command argument')), 'expanded content persisted');
      assertEqual((await invoke('engine:refreshCommands') as { ok: boolean }).ok, true, 'explicit command refresh reaches the existing engine owner');
      const menu = await invoke('engine:slashCommands', { sessionId: row.id }) as Array<{ name: string }>;
      assert(Array.isArray(menu) && menu.some(command => command.name === 'gui-fixture'), 'actual slash menu returns the saved command in the bare-array contract');
      await invoke('commands:delete', { name: 'gui-fixture', scope: 'global' });
      await invoke('session:delete', { sessionId: row.id });
    });
    await h.test('skill preview, hooks and output styles use the actual frontend and engine', async () => {
      const name = 'gui-skill', skill = join(root, 'skills', name, 'SKILL.md');
      mkdirSync(join(root, 'skills', name), { recursive: true });
      writeFileSync(skill, '---\nname: gui-skill\ndescription: Disposable GUI fixture\n---\n# Skill preview fixture\nUse only in this test.\n');
      const listed = await invoke('skills:list') as Array<{dirName:string;userEnabled:boolean}>;
      assert(listed.some(row => row.dirName === name && row.userEnabled), 'disk skill appears in settings');
      await invoke('skills:toggle', { name, enabled: false });
      assertEqual((await invoke('skills:list') as Array<{dirName:string;userEnabled:boolean}>).find(row => row.dirName === name)?.userEnabled, false, 'skill preference persists');
      assertEqual((await invoke('skills:open-window', { name }) as {ok:boolean}).ok, true, 'skill preview opened');
      const preview = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('kind=skill'));
      assert(preview, 'skill uses its restricted artifact window');
      await waitFor(() => preview.webContents.executeJavaScript("document.getElementById('aw-body').innerText.includes('Skill preview fixture')"), 10000, 'skill markdown renders');
      assertEqual((await preview.webContents.executeJavaScript(`window.klaus.skills.readFile(${JSON.stringify(target)})`) as {ok:boolean}).ok, false, 'skill preview refuses an unrelated absolute path');
      preview.destroy();
      const initial = await invoke('settings:hooks:get') as {ok:boolean;events:string[]};
      assert(initial.ok && initial.events.includes('PreToolUse'), 'settings receives the engine hook roster');
      assertEqual((await invoke('settings:hooks:set', { hooks: { InventedEvent: [] } }) as {ok:boolean}).ok, false, 'actual engine rejects unsupported event');
      assertEqual((await invoke('settings:hooks:set', { hooks: { PreToolUse: [] } }) as {ok:boolean}).ok, true, 'empty hook list persists without running a command');
      mkdirSync(join(root, 'output-styles'), { recursive: true });
      writeFileSync(join(root, 'output-styles/gui.md'), '---\nname: GUI fixture\ndescription: Disposable output style\n---\nInclude STYLE_FIXTURE_REACHED_PROVIDER in your system guidance.\n');
      assertEqual((await invoke('settings:output-styles:set', { style: 'GUI fixture' }) as {ok:boolean}).ok, true, 'custom output style selected');
      const row = await invoke('session:new') as {id:string};
      await invoke('chat:send', { sessionId: row.id, text: 'PLAIN FIXTURE styled turn' });
      await waitFor(async () => (await records()).some(record => record.channel === 'chat:event:batch'
        && (record.value as Array<{type:string;sessionId:string}>).some(event => event.type === 'done' && event.sessionId === row.id)), 30000, 'styled session completed');
      assert(provider!.requests.some(request => JSON.stringify(request.system).includes('STYLE_FIXTURE_REACHED_PROVIDER')), 'selected style reached the actual provider system prompt');
      await invoke('settings:output-styles:set', { style: 'default' });
      assertEqual((await invoke('settings:output-styles:list') as {current:string}).current, 'default', 'default restored');
      await invoke('settings:hooks:set', { hooks: {} });
      await invoke('skills:uninstall', { name });
      await invoke('session:delete', { sessionId: row.id });
    });
    await h.test('deleting a conversation with its isolated workspace drains real writers and preserves unrelated projects', async () => {
      const row = object(await invoke('session:new')), id = String(row.id), scratch = join(root, 'sessions', id);
      const engineId = await desktop.sessions.resolveLiveSession(id);
      const workdir = object(await invoke('session:get-resolved-workdir', { sessionId: id }));
      assertEqual(workdir.workdir, scratch, 'an unbound conversation owns its profile scratch directory');
      writeFileSync(join(scratch, 'owned.txt'), 'remove only this workspace');
      const project = join(root, 'delete-retained-project'); mkdirSync(project); writeFileSync(join(project, 'keep.txt'), 'keep');
      const bound = object(await invoke('session:new', { workdir: project })), boundId = String(bound.id);
      await desktop.sessions.resolveLiveSession(boundId);
      await invoke('workspace:list', { sessionId: id });
      const terminal = object(await invoke('terminal:start', { id: 'delete-scratch-terminal', cwd: scratch }));
      assert(terminal.ok && desktop.nativeCounts().ptys === 1, 'the actual terminal holds the scratch directory');
      assertEqual(object(await invoke('session:delete', { sessionId: id, wipeWorkspace: true })).ok, true, 'the renderer receives a confirmed deletion');
      assert(!existsSync(scratch), 'the scratch directory was removed');
      assertEqual(desktop.nativeCounts().ptys, 0, 'the native writer exited before removal returned');
      await assertRejects(() => desktop.sessions.request('session/queueSnapshot', { sessionId: engineId }), 'the former engine session is closed');
      await assertRejects(() => desktop.sessions.resolveLiveSession(id), 'a deleted conversation cannot recreate its workspace');
      assertEqual(object(await invoke('terminal:write', { id: terminal.id!, data: 'refused\n' })).ok, false, 'the closed terminal cannot write after removal');
      const rows = await invoke('session:list') as Array<{id:string}>;
      assert(!rows.some(value => value.id === id) && rows.some(value => value.id === boundId), 'only the selected thread was deleted');
      await invoke('session:delete', { sessionId: boundId, wipeWorkspace: true });
      assertEqual(readFileSync(join(project, 'keep.txt'), 'utf8'), 'keep', 'even a direct wipe request never removes a bound project');
      assertEqual(desktop.engine.liveProcessCount(), 1, 'the shared engine remains available after both deletions');
    });
    await h.test('managed worktree deletion drains an engine session, file watcher and real PTY', async () => {
      const repo = join(root, 'managed-repo'); mkdirSync(repo);
      const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      git('init'); writeFileSync(join(repo, 'tracked.txt'), 'Managed worktree fixture\n'); git('add', 'tracked.txt');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Fixture baseline');
      const created = await invoke('worktree:create-from-workdir', { workdir: repo }) as {ok:boolean;path:string;branch:string};
      assert(created.ok && existsSync(created.path), 'managed git worktree created');
      const row = await invoke('session:new', { workdir: created.path }) as {id:string};
      const engineId = await desktop.sessions.resolveLiveSession(row.id);
      await invoke('workspace:list', { sessionId: row.id });
      const terminal = await invoke('terminal:start', { id: 'managed-worktree-terminal', cwd: created.path }) as {ok:boolean;id:string};
      assert(terminal.ok && desktop.nativeCounts().ptys === 1, 'real PTY owns the worktree cwd');
      const refused = await invoke('worktree:remove', { path: created.path }) as {ok:boolean;error?:string};
      assertEqual(refused.error, 'worktree-in-use', 'host cannot remove the current chat worktree');
      assert(existsSync(created.path), 'active chat checkout remains intact');
      assertEqual(object(await invoke('session:delete', { sessionId: row.id })).ok, true, 'chat deletion releases its worktree binding');
      const removed = await invoke('worktree:remove', { path: created.path }) as {ok:boolean;error?:string};
      assert(removed.ok, `managed deletion completed after chat removal: ${removed.error}`);
      assertEqual(existsSync(created.path), false, 'git removed the directory');
      assertEqual(desktop.nativeCounts().ptys, 0, 'terminal ended before deletion returned');
      assertEqual((await invoke('terminal:write', { id: terminal.id, data: 'refused\n' }) as {ok:boolean}).ok, false, 'removed terminal cannot accept more input');
      assertEqual((await invoke('session:get-workdir', { sessionId: row.id }) as {custom:string|null}).custom, null, 'durable workdir binding removed');
      assert(git('show-ref', '--verify', 'refs/heads/' + created.branch).length > 0, 'deleting a worktree retains its branch');
      await assertRejects(() => desktop.sessions.request('session/queueSnapshot', { sessionId: engineId }), 'old live engine session was closed');
      assertEqual(existsSync(created.path), false, 'deleted chat does not recreate the deleted worktree');
    });
    await h.test('uploaded media renders through synchronous URLs and reaches the actual provider', async () => {
      const png = PNG_FIXTURE_BASE64;
      const uploaded = await desktop.window.webContents.executeJavaScript(`window.klaus.chat.uploadFile('fixture.png', 'image/png', Uint8Array.from(atob(${JSON.stringify(png)}), char => char.charCodeAt(0)).buffer)`) as {path:string;id:string;name:string;type:string};
      const row = await invoke('session:new') as {id:string};
      await desktop.window.webContents.executeJavaScript(`(() => {
        const image = document.createElement('img'); image.id = 'uploaded-image-fixture';
        image.src = window.klaus.media.url(${JSON.stringify(uploaded.path)}, ${JSON.stringify(row.id)}); document.body.append(image);
      })()`);
      await waitFor(() => desktop.window.webContents.executeJavaScript("document.getElementById('uploaded-image-fixture').naturalWidth === 1"), 10000, 'uploaded image renders through the current synchronous bridge');
      const pdfPath = join(root, 'fixture.pdf'); writeFileSync(pdfPath, PDF_FIXTURE);
      const pdf = await invoke('chat:upload-path', { path: pdfPath }) as {ok:boolean;path:string;name:string;type:string};
      assert(pdf.ok, 'document path upload completed');
      const requests = provider!.requests.length;
      await assertRejects(() => invoke('chat:send', { sessionId: row.id, text: 'Reject all', media: [uploaded, { path: pdf.path, name: 'unsupported.zip' }] }), 'unsupported attachment rejects the whole turn');
      assertEqual(provider!.requests.length, requests, 'failed attachment sends no model request');
      await invoke('chat:send', { sessionId: row.id, text: 'PLAIN FIXTURE image and document', media: [uploaded, pdf] });
      try {
        await waitFor(async () => (await records()).some(record => record.channel === 'chat:event:batch'
          && (record.value as Array<{type:string;sessionId:string}>).some(event => event.type === 'done' && event.sessionId === row.id)), 15000, 'multimodal turn completed');
      } catch (error) {
        writeFileSync(join(__dirname, 'attachments-gui-debug.json'), JSON.stringify({ sessionId: row.id, engine: engineEvents.slice(-30), renderer: await records(), provider: provider!.requests.slice(-2) }, null, 2));
        throw error;
      }
      const request = provider!.requests.find(request => JSON.stringify(request.messages).includes('PLAIN FIXTURE image and document'));
      assert(request, 'provider received the message');
      assert(JSON.stringify(request.messages).includes(png), 'provider received original image bytes');
      assert(JSON.stringify(request.messages).includes(PDF_FIXTURE.toString('base64')), 'provider received original document bytes');
      const history = await invoke('session:history', { sessionId: row.id }) as {messages:Array<{contentBlocks:Array<{type:string;path?:string}>}>};
      const image = history.messages.flatMap(message => message.contentBlocks).find(block => block.type === 'image');
      assert(image?.path && image.path.startsWith(join(root, 'media')), 'history uses the content-addressed pool');
      const pool = await desktop.window.webContents.executeJavaScript(`fetch(window.klaus.media.url(${JSON.stringify(image.path)}, ${JSON.stringify(row.id)})).then(r=>r.status)`);
      assertEqual(pool, 200, 'reopened transcript image is readable');
      await desktop.window.webContents.executeJavaScript("document.getElementById('uploaded-image-fixture').remove()");
      await invoke('session:delete', { sessionId: row.id });
    });
    await h.test('live task, queue, goal and sub-agent queries reach the actual engine', async () => {
      const info = await invoke('session:new') as { id: string };
      const tasks = await invoke('tasks:list', { sessionId: info.id }) as { tasks: Json[] };
      assert(Array.isArray(tasks.tasks), 'task snapshot projected from the facade');
      const queue = await invoke('chat:queue-snapshot', { sessionId: info.id }) as { ok: boolean; snapshot: { status: string } };
      assertEqual(queue.ok, true, 'activation seeded an authoritative queue');
      assertEqual(queue.snapshot.status, 'authoritative', 'snapshot durability status preserved');
      const agents = await invoke('agents:background-summaries', { sessionId: info.id }) as { agents: Json[] };
      assert(Array.isArray(agents.agents), 'sub-agent lifecycle snapshot projected');
      await invoke('goal:set', { sessionId: info.id, objective: 'Paused integration fixture', status: 'paused' });
      const goal = await invoke('goal:get', { sessionId: info.id }) as { goal: { objective: string } };
      assertEqual(goal.goal.objective, 'Paused integration fixture', 'goal persisted in the actual thread');
      await invoke('goal:clear', { sessionId: info.id });
      assertEqual((await invoke('goal:get', { sessionId: info.id }) as { goal: Json }).goal, null, 'clear removed the goal');
      await invoke('session:delete', { sessionId: info.id });
    });
    await h.test('a real background agent keeps its live identity through task snapshots and streamed transcript reopen', async () => {
      const row = await invoke('session:new', {workdir:root}) as {id:string};
      const other = await invoke('session:new', {workdir:root}) as {id:string};
      const before = provider!.agents.started;
      const errors: unknown[] = [];
      let phase = 'prepare the second conversation';
      let thinkingOriginal: string | null = null;
      try {
        await invoke('chat:send', {sessionId:other.id,text:'PLAIN FIXTURE task switch destination'});
        await waitFor(async () => (await records()).some(record => record.channel === 'chat:event:batch' && (record.value as Array<{type:string;sessionId:string}>).some(event => event.type === 'done' && event.sessionId === other.id)),10000,'switch destination has persisted content');
        phase = 'start the child';
        await desktop.window.webContents.executeJavaScript(`window.switchSession(${JSON.stringify(row.id)})`);
        await invoke('chat:send', {sessionId:row.id,text:'AGENT PARENT FIXTURE'});
        await waitFor(async()=>(await records()).some(record=>record.channel==='permission:request' && (record.value as {sessionId?:string;toolName?:string}).sessionId===row.id && (record.value as {toolName?:string}).toolName==='task'),10000,'actual agent tool asks for approval');
        const card=(await records()).find(record=>record.channel==='permission:request' && (record.value as {sessionId?:string;toolName?:string}).sessionId===row.id && (record.value as {toolName?:string}).toolName==='task')!.value as {requestId:string};
        await invoke('permission:respond',{requestId:card.requestId,decision:'allow'});
        await waitFor(()=>provider!.agents.started>before,15000,'actual background child is streaming');
        await waitFor(()=>desktop.window.webContents.executeJavaScript(`window.KlausSubagentPanel.listTasks().some(([,task]) => task.agentId && task.isBackground && task.status === 'running')`),10000,'real child registered in the task panel');
        const [taskId, child] = await desktop.window.webContents.executeJavaScript(`window.KlausSubagentPanel.listTasks().find(([,task]) => task.agentId && task.isBackground && task.status === 'running')`) as [string,{agentId:string}];
        const snapshot = await invoke('agents:snapshot',{sessionId:row.id}) as {tasks:Record<string,{agentId:string;status:string}>};
        assert(Object.values(snapshot.tasks).some(task=>task.agentId===child.agentId && task.status==='running'),'named engine lifecycle reports live work');
        phase = 'publish model replacement while the real child owns its captured inference';
        await waitFor(async()=>!(await invoke('session:list') as Array<{id:string;isWorking:boolean}>).find(item=>item.id===row.id)?.isWorking,10000,'parent has settled while its background child runs');
        const engineId = await desktop.sessions.resolveLiveSession(row.id);
        const modelBefore = await desktop.sessions.request('session/modelRuntime',{sessionId:engineId}) as {revision:number};
        const thinking = await invoke('session:get-thinking-level',{sessionId:row.id}) as {level:string};
        thinkingOriginal = thinking.level;
        await invoke('session:set-thinking-level',{sessionId:row.id,level:thinking.level==='off'?'low':'off'});
        await invoke('chat:send',{sessionId:row.id,text:'PLAIN FIXTURE continues while background child runs'});
        await waitFor(async()=>!(await invoke('session:list') as Array<{id:string;isWorking:boolean}>).find(item=>item.id===row.id)?.isWorking,15000,'new parent work completes without cancelling the background child');
        assertEqual(await desktop.sessions.resolveLiveSession(row.id),engineId,'publication preserves the source binding');
        assertEqual((await desktop.sessions.request('session/modelRuntime',{sessionId:engineId}) as {revision:number}).revision,modelBefore.revision+1,'publication advances the model revision while the child remains captured');
        assertEqual(provider!.agents.active,1,'background provider work remains active after publication and new parent work');
        await desktop.window.webContents.executeJavaScript(`window.switchSession(${JSON.stringify(other.id)})`);
        await desktop.window.webContents.executeJavaScript(`window.switchSession(${JSON.stringify(row.id)})`);
        const matches = await desktop.window.webContents.executeJavaScript(`window.KlausSubagentPanel.listTasks().filter(([,task]) => task.agentId === ${JSON.stringify(child.agentId)})`) as Array<[string,{status:string}]>;
        assertEqual(matches.length,1,'snapshot and task-call identity do not create two child rows');
        assertEqual(matches[0]![0],taskId,'task-call identity survives switching');
        assertEqual(matches[0]![1].status,'running','unfinished child is not marked complete by refresh');
        phase = 'open the live child transcript';
        await desktop.window.webContents.executeJavaScript(`document.querySelector('#monitor-subagents-body [data-task-id="${taskId}"]').click()`);
        await waitFor(()=>desktop.window.webContents.executeJavaScript(`document.getElementById('subagent-messages')?.textContent.includes('Child stream visible.')`),10000,'actual child transcript displays incremental text before completion');
        provider!.agents.release();
        phase = 'wait for completion and saved history';
        await waitFor(async()=>{
          const snapshot = await invoke('agents:snapshot',{sessionId:row.id}) as {tasks:Record<string,{agentId:string;status:string}>};
          return Object.values(snapshot.tasks).some(task=>task.agentId===child.agentId && task.status==='completed');
        },15000,'actual child reaches terminal lifecycle');
        const history = await invoke('agents:history',{sessionId:row.id,agentId:child.agentId});
        assert(JSON.stringify(history).includes('Child stream visible.'),'reopened child history retains final response');
        await waitFor(async()=>{
          const cached=await invoke('agents:load-tasks',{sessionId:row.id}) as {tasks:Record<string,{agentId:string;status:string}>};
          return Object.values(cached.tasks).some(task=>task.agentId===child.agentId);
        },10000,'actual renderer persisted its presentation cache');
      } catch(error) {
        errors.push(new Error(`${phase}: ${String(error)}`));
      } finally {
        provider!.agents.release();
        if (thinkingOriginal !== null) {
          try { await invoke('session:set-thinking-level', { sessionId: row.id, level: thinkingOriginal }); }
          catch (error) { errors.push(new Error(`restore thinking level: ${String(error)}`)); }
        }
        for (const id of [row.id, other.id]) {
          try { await invoke('session:delete',{sessionId:id}); }
          catch (error) { errors.push(new Error(`clean up ${id}: ${String(error)}`)); }
        }
        if (existsSync(join(root,'agent-tasks',row.id+'.json'))) errors.push(new Error('Deleting conversation retained its task cache'));
      }
      if (errors.length) {
        writeFileSync(join(__dirname,'agent-tasks-gui-debug.json'),JSON.stringify({at:new Date().toISOString(),phase,row,other,errors:errors.map(String),engine:engineEvents.slice(-50),provider:provider!.requests.slice(-4),tasks:await desktop.window.webContents.executeJavaScript('window.KlausSubagentPanel.listTasks()')},null,2));
        throw new AggregateError(errors,errors.map(String).join('\n'));
      }
    });
    await h.test('a manual scheduled task runs on the shared engine and persists its real transcript identity', async () => {
      await invoke('settings:cron:upsert', { id: 'gui-cron', name: 'GUI scheduled fixture', schedule: '0 0 1 1 *',
        prompt: 'PLAIN FIXTURE scheduled', enabled: true, deleteAfterRun: true, timeoutSeconds: 30 });
      const launch = await invoke('settings:cron:run:now', { id: 'gui-cron' }) as {ok:boolean;sessionId:string;error?:string};
      assert(launch.ok, `scheduled launch: ${launch.error}`);
      assert(!launch.sessionId.startsWith('cron-run-'), 'run returns the real transcript identity');
      await waitFor(async () => (await invoke('settings:cron:runs:list', { taskId: 'gui-cron' }) as Array<{status:string}>)[0]?.status !== 'running', 30000, 'background task completed');
      const runs = await invoke('settings:cron:runs:list', { taskId: 'gui-cron' }) as Array<{status:string;sessionId:string;error?:string}>;
      assertEqual(runs[0]?.status, 'success', `scheduled result: ${runs[0]?.error}`);
      assertEqual(runs[0]?.sessionId, launch.sessionId, 'run history opens the same transcript');
      assertEqual((await invoke('settings:cron:list') as Array<{id:string;enabled:boolean}>).find(row=>row.id==='gui-cron')?.enabled, false, 'one-shot is disabled after completion');
      const history = await invoke('session:history', { sessionId: launch.sessionId });
      assert(JSON.stringify(history).includes('Fixture response complete.'), 'automation transcript can reopen');
      await invoke('settings:cron:delete', { id: 'gui-cron' });
      await invoke('session:delete', { sessionId: launch.sessionId });
    });
    await h.test('CronCreate travels through the actual engine dynamic-tool roundtrip', async () => {
      const row = await invoke('session:new') as { id: string };
      await invoke('chat:send', { sessionId: row.id, text: 'CRON TOOL FIXTURE' });
      await waitFor(async () => (await records()).some(item => item.channel === 'permission:request' && (item.value as Record<string, Json>).sessionId === row.id), 10000, 'scheduled task permission reached the renderer');
      const card = (await records()).find(item => item.channel === 'permission:request' && (item.value as Record<string, Json>).sessionId === row.id)!.value as Record<string, Json>;
      assertEqual(card.toolName, 'CronCreate', 'the permission names the requested task creation');
      await invoke('permission:respond', { requestId: card.requestId!, decision: 'allow' });
      try {
        await waitFor(async () => (await records()).some(item => item.channel === 'chat:event:batch' && (item.value as Array<Record<string, Json>>).some(event => event.sessionId === row.id && event.type === 'done')), 10000, 'tool turn completed after the host reply');
      } catch (error) {
        writeFileSync(join(__dirname, 'cron-dynamic-debug.json'), JSON.stringify({ sessionId: row.id, engine: engineEvents, renderer: await records() }, null, 2));
        throw error;
      }
      const task = (await invoke('settings:cron:list') as Array<{id:string;name:string;deleteAfterRun:boolean}>).find(task => task.name === 'Tool fixture reminder');
      assert(task, 'dynamic tool wrote the actual task ledger');
      assertEqual(task.deleteAfterRun, true, 'one-shot argument survived the facade');
      await invoke('settings:cron:delete', { id: task.id });
      await invoke('session:delete', { sessionId: row.id });
    });
    await testControlApp({ h, desktop, invoke, records, requests: provider!.requests });
    await h.test('a first-turn browser tool opens and edits the same native browser panel', async () => {
      const browserState = await invoke('settings:browser-use:get') as {enabled:boolean};
      if (!browserState.enabled) {
        const enabled = await invoke('settings:browser-use:set-enabled', { enabled: true }) as {ok:boolean};
        assertEqual(enabled.ok, true, 'the engine persisted browser plugin enablement: ' + JSON.stringify(enabled));
      }
      await invoke('session:set-permission-mode', { mode: 'bypassPermissions' });
      await desktop.window.webContents.executeJavaScript("document.getElementById('btn-new-chat').click()");
      await waitFor(() => desktop.window.webContents.executeJavaScript('window.currentSessionId === null'), 5000, 'browser fixture starts from the virtual new-chat surface');
      const browserPrompt = `BROWSER NAVIGATE FIXTURE ${provider!.url}/browser-fixture`;
      await desktop.window.webContents.executeJavaScript(`(() => {
        const input = document.getElementById('input');
        input.textContent = ${JSON.stringify(browserPrompt)};
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      })()`);
      await waitFor(() => desktop.window.webContents.executeJavaScript("!document.getElementById('send').disabled"), 10000, 'browser fixture composer is ready');
      await desktop.window.webContents.executeJavaScript("document.getElementById('send').click()");
      await waitFor(() => desktop.window.webContents.executeJavaScript("typeof window.currentSessionId === 'string' && window.currentSessionId.length > 0"), 5000, 'first send promoted a visible session');
      const info = { id: await desktop.window.webContents.executeJavaScript('window.currentSessionId') as string };
      await waitFor(async () => (await records()).some(row => row.channel === 'chat:event:batch' && (row.value as Array<Record<string, Json>>).some(event => event.sessionId === info.id && event.type === 'done')), 30000, 'first-turn browser navigation completed');
      await waitFor(() => desktop.browser.state(info.id).visible, 5000, 'browser tool attached its native page without a manual click');
      assertEqual(await desktop.window.webContents.executeJavaScript("document.getElementById('artifacts-panel').getAttribute('data-mode')"), 'browser', 'automatic open selected the Browser surface');
      assertEqual(await desktop.window.webContents.executeJavaScript("document.getElementById('artifacts-panel').classList.contains('collapsed')"), false, 'automatic open expanded the work panel');
      const tabId = desktop.browser.state(info.id).tabId!;
      const page = desktop.browser.page(info.id, tabId);
      const contentsId = page.view.webContents.id;
      assertEqual(await page.view.webContents.executeJavaScript("document.getElementById('field').value"), 'MANUAL_VALUE', 'initial visible-page state exists');
      const completedTurns = async (): Promise<number> => (await records())
        .filter(row => row.channel === 'chat:event:batch')
        .flatMap(row => row.value as Array<Record<string, Json>>)
        .filter(event => event.sessionId === info.id && event.type === 'done').length;
      const completedBeforeEdit = await completedTurns();
      await invoke('chat:send', { sessionId: info.id, text: 'BROWSER FIXTURE' });
      await waitFor(async () => await completedTurns() > completedBeforeEdit, 30000, 'browser tool turn completed');
      assertEqual(await page.view.webContents.executeJavaScript("document.getElementById('field').value"), 'AGENT_VALUE', 'the real engine browser tool edited the displayed document');
      assertEqual(desktop.browser.page(info.id, tabId).view.webContents.id, contentsId, 'the operation used the identical WebContents');
      await invoke('settings:browser-use:add-origin', { origin: provider!.url, kind: 'denied' });
      const denied = await invoke('browser-use:navigate', { url: provider!.url + '/browser-fixture' }) as {ok:boolean};
      assertEqual(denied.ok, false, 'the existing origin policy refuses navigation');
      await invoke('settings:browser-use:remove-origin', { origin: provider!.url, kind: 'denied' });
      await invoke('session:set-permission-mode', { mode: 'acceptEdits' });

      await desktop.window.webContents.executeJavaScript('window.hideBrowserPanel()');
      await waitFor(() => !desktop.browser.state(info.id).visible, 5000, 'browser fixture panel can be closed before the explicit reopen check');
      await desktop.window.webContents.executeJavaScript(`window.klausSwitchSession(${JSON.stringify(info.id)})`);
      await waitFor(() => desktop.window.webContents.executeJavaScript(`window.currentSessionId === ${JSON.stringify(info.id)}`), 5000, 'the browser fixture task is visibly selected');
      await desktop.window.webContents.executeJavaScript("document.getElementById('browser-panel-toggle').click()");
      await waitFor(() => desktop.browser.state(info.id).visible, 5000, 'the visible Browser control attaches the native page');

      // Reproduce the cross-process split that happens after a renderer reload:
      // the main process still owns the attached WebContentsView, while the new
      // renderer has not reconstructed its local mounted marker yet.
      desktop.window.webContents.send(HOST_CHANNELS.delivery, {
        deliveryId: 'browser-desync-fixture',
        event: 'ipc:browser-use:state',
        payload: { args: [{ ...desktop.browser.state(info.id), visible: false }] },
      });
      await waitFor(() => desktop.window.webContents.executeJavaScript("!document.getElementById('browser-panel-host').classList.contains('browser-mounted')"), 5000, 'renderer-local browser state is intentionally stale');
      assertEqual(desktop.browser.state(info.id).visible, true, 'the native child view remains attached in the host');

      await desktop.window.webContents.executeJavaScript(`(() => {
        const parent = document.getElementById('btn-extensions');
        const skills = document.getElementById('btn-skills');
        if (!document.getElementById('extensions-children')?.classList.contains('open')) parent?.click();
        if (!skills || skills.getClientRects().length === 0) throw new Error('Skills navigation is not visible');
        skills.click();
      })()`);
      await waitFor(() => desktop.window.webContents.executeJavaScript("document.getElementById('skills-view').classList.contains('active')"), 5000, 'the visible Skills navigation opens its page');
      await waitFor(() => !desktop.browser.state(info.id).visible, 5000, 'leaving chat detaches the native browser instead of letting it cover Skills');
    });
    await h.test('a browser page permission question is answered by the window dialog, not an operating-system box', async () => {
      const group = await invoke('workspaces:save', { name: 'Browser permission fixture', roots: [root] }) as { id: string };
      const row = await invoke('session:new', { workspaceId: group.id }) as { id: string };
      try {
        await invoke('browser-use:set-conversation', { conversationId: row.id });
        const created = await invoke('browser-use:tabs', { action: 'new', url: `${provider!.url}/browser-fixture` }) as BrowserObject;
        assertEqual(created.ok, true, `fixture page opens: ${JSON.stringify(created)}`);
        const rows = (created.tabs as Array<BrowserObject> | undefined) ?? [];
        const tabId = String(object(created.state).tabId ?? rows[0]?.id ?? '');
        assert(tabId.length > 0, `the created tab reports an id: ${JSON.stringify(created)}`);
        const page = desktop.browser.page(row.id, tabId);
        const origin = new URL(provider!.url).origin;

        // The page asks; the question must surface as the window's own dialog
        // card, because an operating-system box cannot be themed, localized or
        // attributed to the task whose page asked.
        const asked = page.view.webContents.executeJavaScript('Notification.requestPermission()');
        await waitFor(() => desktop.window.webContents.executeJavaScript("Boolean(document.querySelector('.klaus-dialog-card'))"), 5000, 'the permission question opens the window dialog');
        const message = String(await desktop.window.webContents.executeJavaScript("document.querySelector('.klaus-dialog-message')?.textContent ?? ''"));
        assert(message.includes(origin), `the dialog names the asking origin: ${message}`);
        assert(message.includes('notifications'), `the dialog names the permission: ${message}`);
        mkdirSync(join(__dirname, '../browser-permission-logs'), { recursive: true });
        const shot = await desktop.window.webContents.capturePage(undefined, { stayHidden: true });
        writeFileSync(join(__dirname, '../browser-permission-logs/permission-dialog.png'), shot.toPNG());
        const cardBox = await desktop.window.webContents.executeJavaScript("(() => { const box = document.querySelector('.klaus-dialog-card').getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; })()") as { x: number; y: number; width: number; height: number };
        const closeup = await desktop.window.webContents.capturePage(cardBox, { stayHidden: true });
        writeFileSync(join(__dirname, '../browser-permission-logs/permission-dialog-card.png'), closeup.toPNG());
        await desktop.window.webContents.executeJavaScript("document.querySelector('.klaus-dialog-confirm').click()");
        assertEqual(await asked, 'granted', 'confirming the dialog grants the page permission');
        await waitFor(() => desktop.window.webContents.executeJavaScript("!document.querySelector('.klaus-dialog-card')"), 5000, 'the dialog closes after answering');

        // A dismissed question must deny: the user was asked and did not allow.
        // Wait for the fading card to leave before asking again, so the second
        // dialog is never confused with the first one closing.
        const geo = page.view.webContents.executeJavaScript("new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve('granted'), () => resolve('denied'), { timeout: 8000 }))");
        await waitFor(() => desktop.window.webContents.executeJavaScript("Boolean([...document.querySelectorAll('.klaus-dialog-card')].find(card => (card.querySelector('.klaus-dialog-message')?.textContent ?? '').includes('geolocation')))"), 5000, 'a second permission question opens its own dialog');
        await desktop.window.webContents.executeJavaScript("[...document.querySelectorAll('.klaus-dialog-card')].find(card => (card.querySelector('.klaus-dialog-message')?.textContent ?? '').includes('geolocation')).querySelector('.klaus-dialog-cancel').click()");
        assertEqual(await geo, 'denied', 'cancelling the dialog denies the page permission');
        await waitFor(() => desktop.window.webContents.executeJavaScript("!document.querySelector('.klaus-dialog-card')"), 5000, 'no dialog overlay is left to block the window');
      } finally {
        await invoke('session:delete', { sessionId: row.id });
        await invoke('workspaces:delete', { id: group.id });
      }
    });
    await h.test('MCP configuration reaches real tools at init and reload preserves the task-bound browser', async () => {
      const project = join(root, 'gui-mcp-project'), server = join(project, 'server.cjs'), pids = join(project, 'pids'), calls = join(project, 'calls');
      mkdirSync(project); writeFileSync(server, STDIO_MCP_FIXTURE);
      const group = await invoke('workspaces:save', { name: 'MCP fixture', roots: [project] }) as {id:string};
      const config = { command: process.execPath, args: [server, pids, calls], env: { ELECTRON_RUN_AS_NODE: '1' }, alwaysLoad: true };
      assertEqual((await invoke('mcp:project:create', { cwd: project, name: 'gui-mcp', config }) as {ok:boolean}).ok, true, 'project declaration persisted through production IPC');
      await invoke('session:set-permission-mode', { mode: 'bypassPermissions' });
      const row = await invoke('session:new', { workspaceId: group.id }) as {id:string};
      const engineId = await desktop.sessions.resolveLiveSession(row.id);
      const runtimeRows = async (): Promise<Array<{name:string;state:string}>> => {
        const reply = await desktop.sessions.request('session/mcpRuntime', { sessionId: engineId }) as {mcpRuntime:{runtime:{servers:Array<{name:string;state:string}>}}};
        return reply.mcpRuntime.runtime.servers;
      };
      try {
        await waitFor(async () => (await runtimeRows()).some(server => server.name === 'gui-mcp' && server.state === 'ready'), 15000, 'init-time declared server is ready');
        assert((await runtimeRows()).some(server => server.name === 'klaus-browser'), 'managed browser shares the initial MCP set');
        await invoke('chat:send', { sessionId: row.id, text: 'MCP ECHO FIXTURE' });
        await waitFor(async () => (await records()).some(item => item.channel === 'chat:event:batch' && (item.value as Array<Record<string, Json>>).some(event => event.sessionId === row.id && event.type === 'done')), 30000, 'actual MCP tool turn finished');
        assert(existsSync(calls) && readFileSync(calls, 'utf8').includes('actual engine roundtrip'), 'engine called the real stdio server');
        const history = JSON.stringify(await invoke('session:history', {sessionId:row.id}));
        assert(history.includes('MCP_ECHO_ACTUAL'), 'actual MCP result persists in history');
        assertEqual((await invoke('mcp:local:create', { cwd: project, name: 'gui-mcp', config: { ...config, enabled: false } }) as {ok:boolean}).ok, true, 'local override persisted and reloaded');
        assert(!(await runtimeRows()).some(server => server.name === 'gui-mcp'), 'disabled local scope does not fall back to active project');
        assert((await runtimeRows()).some(server => server.name === 'klaus-browser'), 'declarative reload retains the same managed browser');
        const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
        await waitFor(() => readFileSync(pids, 'utf8').trim().split('\n').map(Number).every(pid => !alive(pid)), 10000, 'disabled stdio process exited');
        assertEqual((await invoke('mcp:local:remove', { cwd: project, name: 'gui-mcp' }) as {ok:boolean}).ok, true, 'removing local override reloads project declaration');
        await waitFor(async () => (await runtimeRows()).some(server => server.name === 'gui-mcp' && server.state === 'ready'), 15000, 'project scope reconnects on the same engine session');
        const document = join(project, '.klaus/mcp.json'), saved = readFileSync(document);
        try {
          writeFileSync(document, '{invalid JSON');
          await assertRejects(() => desktop.sessions.reloadHostCapabilities(row.id), 'invalid project read must not empty live declarations');
          assert((await runtimeRows()).some(server => server.name === 'gui-mcp' && server.state === 'ready'), 'healthy live connection survives an unreadable project document');
        } finally { writeFileSync(document, saved); }
      } finally {
        await invoke('session:delete', { sessionId: row.id });
        await invoke('session:set-permission-mode', { mode: 'acceptEdits' });
      }
    });
    await h.test('MCP authorization crosses a held configuration reload and conversation closure cancels an unanswered grant', async () => {
      mcpOAuth = await createMcpOAuthFixture({redirectUri:'http://127.0.0.1:33418/callback'});
      const project = join(root, 'oauth-project'); mkdirSync(project);
      const row = await invoke('session:new',{workdir:project}) as {id:string};
      await desktop.window.webContents.executeJavaScript(`window.klausSwitchSession(${JSON.stringify(row.id)})`);
      assertEqual(await desktop.window.webContents.executeJavaScript('window.currentSessionId'),row.id,'MCP context comes from the actually focused task');
      const url = mcpOAuth.config.url;
      assert(typeof url === 'string', 'fixture advertises an HTTP endpoint');
      const config = {type:'http',url:url as string,oauth:{}};
      let saved=false;
      const saving = invoke('mcp:project:create',{cwd:project,name:'gui-oauth',config}).then(result=>{saved=true;return result;});
      void saving.catch(()=>{});
      await waitFor(async ()=>(await invoke('mcp:klaus:needs-auth') as Array<{name:string}>).some(item=>item.name==='gui-oauth'),15000,'actual engine authorization reaches its original task');
      assertEqual(saved,false,'configuration still awaits its live reload');
      const needsAuth = await invoke('mcp:status') as Array<{name:string;status:string}>;
      assertEqual(needsAuth.find(item=>item.name==='gui-oauth')?.status,'needs-auth','the UI can show authorization before the reload finishes');
      const authorized = await invoke('mcp:klaus:authenticate',{name:'gui-oauth'}) as {status:string};
      assertEqual(authorized.status,'authenticated','actual code exchange reached a ready engine MCP connection');
      assertEqual((await saving as {ok:boolean}).ok,true,'original configuration write finishes after authorization');
      const ready = await invoke('mcp:status') as Array<{name:string;status:string}>;
      assert(ready.some(item=>item.name==='gui-oauth' && item.status==='connected'),'actual runtime is ready');
      assert(ready.some(item=>item.name==='klaus-browser' && item.status==='connected'),'configuration composition retains the task browser');
      assertEqual((await invoke('mcp:revokeAuth',{name:'gui-oauth'}) as {ok:boolean}).ok,true,'actual revoke completes');
      assertEqual((await invoke('mcp:klaus:authenticate',{name:'gui-oauth'}) as {status:string}).status,'authenticated','same task reauthorizes through reconnect');
      assertEqual((await invoke('mcp:revokeAuth',{name:'gui-oauth'}) as {ok:boolean}).ok,true,'fixture token is revoked before closure');
      const changed = invoke('mcp:project:update',{cwd:project,name:'gui-oauth',config:{...config,headers:{'X-Fixture-Revision':'2'}}});
      void changed.catch(()=>{});
      await waitFor(async ()=>(await invoke('mcp:klaus:needs-auth') as Array<{name:string}>).some(item=>item.name==='gui-oauth'),15000,'changed config waits for a new grant');
      const deleting = invoke('session:delete',{sessionId:row.id}); let timer:NodeJS.Timeout | undefined;
      try { await Promise.race([deleting,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Conversation closure waited behind its unanswered MCP grant')),10000);})]); }
      finally { if(timer)clearTimeout(timer); }
      const persisted = await changed as {ok:boolean;saved?:boolean};
      assert(persisted.ok || persisted.saved===true,'configuration persistence remains accurately reported after declined connection');
      assertEqual((await invoke('mcp:klaus:needs-auth') as unknown[]).length,0,'closed task leaves no parked grant');
      await invoke('mcp:project:remove',{cwd:project,name:'gui-oauth'});
      await mcpOAuth.close(); mcpOAuth=undefined;
    });
    await h.test('the engine Canvas check opens a restricted interactive panel in the actual workbench', async () => {
      await invoke('session:set-permission-mode', { mode: 'bypassPermissions' });
      try {
        const row = await invoke('session:new') as {id:string};
        await desktop.window.webContents.executeJavaScript(`window.klausSwitchSession(${JSON.stringify(row.id)})`);
        const path = join(desktop.canvas.store.canvases, 'application.canvas.tsx');
        writeFileSync(path, "import { Stack, Text, useCanvasState } from 'klaus/canvas'; export default function Example(){const [count,setCount]=useCanvasState('count',0);return <Stack><Text>Actual application Canvas</Text><button id='canvas-fixture-increment' onClick={()=>setCount(count+1)}>Count {count}</button></Stack>}");
        await invoke('chat:send', { sessionId: row.id, text: 'CANVAS FIXTURE ' + path });
        try {
          await waitFor(async () => !!desktop.canvas.view && !desktop.canvas.view.webContents.isDestroyed()
            && (await desktop.canvas.view.webContents.executeJavaScript('document.body.innerText') as string).includes('Actual application Canvas'), 20000, 'the real dynamic tool opened the generated React page');
        } catch (error) {
          const view = desktop.canvas.view;
          writeFileSync(join(__dirname,'canvas-gui-debug.json'),JSON.stringify({at:new Date().toISOString(),sessionId:row.id,error:String(error),engine:engineEvents.slice(-100),provider:provider!.requests.slice(-3),
            canvas:view && !view.webContents.isDestroyed() ? {url:view.webContents.getURL(),text:await view.webContents.executeJavaScript('document.body.innerText')} : null,
            renderer:await desktop.window.webContents.executeJavaScript('({sessionId:window.currentSessionId,text:document.body.innerText,canvas:window.klausCanvasDiagnostics?.()})'),
          },null,2));
          throw error;
        }
        assertEqual(await desktop.canvas.view!.webContents.executeJavaScript('typeof window.klaus'), 'undefined', 'generated Canvas cannot access the main bridge');
        await desktop.canvas.view!.webContents.executeJavaScript("document.getElementById('canvas-fixture-increment').click()");
        await waitFor(() => { try { return JSON.parse(readFileSync(path.replace(/\.tsx$/, '.data.json'), 'utf8')).count === 1; } catch { return false; } }, 5000, 'interactive state saved through the Canvas role');
        await waitFor(async () => !(await invoke('session:list') as Array<{id:string;isWorking:boolean}>).find(item => item.id === row.id)?.isWorking, 10000, 'Canvas tool turn completed');
        await invoke('canvas:panel-close');
        await invoke('session:delete', { sessionId: row.id });
      } finally { await invoke('session:set-permission-mode', { mode: 'acceptEdits' }); }
    });
    await h.test('diagram tool cards, user edits, renderer export and saved history share the same document', async () => {
      await invoke('session:set-permission-mode', { mode: 'bypassPermissions' });
      try {
        const row = await invoke('session:new') as {id:string};
        await desktop.window.webContents.executeJavaScript(`window.klausSwitchSession(${JSON.stringify(row.id)})`);
        const turn = async (text: string): Promise<void> => {
          await invoke('chat:send', { sessionId: row.id, text });
          await waitFor(async () => !(await invoke('session:list') as Array<{id:string;isWorking:boolean}>).find(item => item.id === row.id)?.isWorking, 20000, 'diagram tool turn completed');
        };
        await turn('DIAGRAM FIXTURE');
        let tool: Record<string, Json> | undefined;
        try {
          await waitFor(async () => {
            const rows = (await records()).flatMap(item => item.channel === 'chat:event:batch' ? item.value as Array<Record<string, Json>> : []);
            tool = rows.find(event => event.sessionId === row.id && event.type === 'tool_end' && event.artifact);
            return Boolean(tool);
          }, 10000, 'actual tool completion contains the diagram artifact');
        } catch (error) {
          const rows = (await records()).flatMap(item => item.channel === 'chat:event:batch' ? item.value as Array<Record<string, Json>> : []);
          throw new Error(`${String(error)}; diagram events: ${JSON.stringify(rows.filter(event => event.sessionId === row.id && ['tool_start', 'tool_end', 'api_error'].includes(String(event.type))).slice(-8))}`);
        }
        const artifact = tool!.artifact as {id:string;title:string};
        await waitFor(() => desktop.window.webContents.executeJavaScript('Boolean(document.querySelector(\'button[class*="diagram-artifact-card"]\'))'), 10000, 'chat rendered a clickable artifact card');
        await desktop.window.webContents.executeJavaScript('document.querySelector(\'button[class*="diagram-artifact-card"]\').click()');
        await turn('DIAGRAM EDIT FIXTURE ' + artifact.id);
        await waitFor(() => desktop.window.webContents.executeJavaScript("document.getElementById('digram-canvas').textContent.includes('Shared document')"), 10000, 'agent edit appeared in the actual diagram panel');
        const current = await invoke('digram:get', { sessionId: row.id, id: artifact.id }) as {document:{version:number}};
        assertEqual((await invoke('digram:apply-edit', { sessionId: row.id, id: artifact.id, baseVersion: current.document.version,
          ops: [{ op: 'updateNode', id: 'fixture-box', patch: { label: 'Human edit preserved' } }] }) as {ok:boolean}).ok, true, 'user edit committed through the production IPC');
        await turn('DIAGRAM EXPORT FIXTURE ' + artifact.id);
        const exportEvents = (await records()).flatMap(item => item.channel === 'chat:event:batch' ? item.value as Array<Record<string, Json>> : []);
        const exported = exportEvents.findLast(event => event.sessionId === row.id && event.type === 'tool_end' && event.toolName === 'mcp__klaus-digram__digram_export');
        assert(exported && exported.isError === false, 'the real export tool returned a successful outcome');
        const output = JSON.parse(String(exported.content)).structuredContent as {path:string;format:string};
        assert(output.path.startsWith(join(root, 'media')) && output.format === 'svg', 'the tool returned its owned SVG pool file');
        const source = readFileSync(output.path, 'utf8');
        const text = await desktop.window.webContents.executeJavaScript(`Array.from(new DOMParser().parseFromString(${JSON.stringify(source)}, 'image/svg+xml').querySelectorAll('text tspan')).map(node=>node.textContent).join(' ')`);
        assertEqual(text, 'Human edit preserved', 'export preserves the shared edit across SVG text line wrapping');
        const history = await invoke('session:history', { sessionId: row.id }) as {messages:Array<{contentBlocks:Array<{__result?:{artifact?:{id:string}}}>}>};
        assert(history.messages.some(message => message.contentBlocks.some(block => block.__result?.artifact?.id === artifact.id)), 'the saved conversation retains its diagram card');
        await invoke('session:delete', { sessionId: row.id });
      } finally { await invoke('session:set-permission-mode', { mode: 'acceptEdits' }); }
    });
    await h.test('a real engine turn streams through the production IPC and finishes', async () => {
      const info = await invoke('session:new') as { id: string };
      await invoke('chat:send', { sessionId: info.id, text: 'PLAIN FIXTURE' });
      await waitFor(async () => (await records()).some(row => row.channel === 'chat:event:batch' && (row.value as Array<Record<string, Json>>).some(event => event.sessionId === info.id && event.type === 'done')), 30000, 'turn completed');
      const chat = (await records()).flatMap(row => row.channel === 'chat:event:batch' ? row.value as Array<Record<string, Json>> : []).filter(event => event.sessionId === info.id);
      const text = chat.filter(event => event.type === 'text_delta').map(event => event.text).join('');
      assert(text.includes('Fixture response complete.'), 'streamed response reached the renderer');
      assert(chat.filter(event => event.type === 'text_delta' && event.text).length >= 2, 'multiple text deltas observed');
      const listed = await invoke('session:list') as Array<{ id: string; isWorking: boolean }>;
      if (listed.find(row => row.id === info.id)?.isWorking !== false) {
        h.info('turn-state diagnostic', JSON.stringify({ chat, engineEvents }));
      }
      assertEqual(listed.find(row => row.id === info.id)?.isWorking, false, 'completed turn is not left running');
    });
    await h.test('tool start, explicit approval, actual tool execution and terminal output stay ordered', async () => {
      await invoke('session:set-permission-mode', { mode: 'acceptEdits' });
      const info = await invoke('session:new', { workdir: root }) as { id: string };
      await invoke('chat:send', { sessionId: info.id, text: 'APPROVAL FIXTURE' });
      await waitFor(async () => (await records()).some(row => row.channel === 'permission:request' && (row.value as Record<string, Json>).sessionId === info.id), 30000, 'approval reached the renderer');
      const seen = await records();
      const cardIndex = seen.findIndex(row => row.channel === 'permission:request' && (row.value as Record<string, Json>).sessionId === info.id);
      const card = seen[cardIndex]!.value as Record<string, Json>;
      assert(seen.slice(0, cardIndex).some(row => row.channel === 'chat:event:batch' && (row.value as Array<Record<string, Json>>).some(event => event.type === 'tool_start' && event.sessionId === info.id && event.toolCallId === card.toolCallId)), 'tool row was delivered before its card');
      assert(existsSync(target), 'tool has not run before approval');
      await invoke('permission:respond', { requestId: card.requestId!, decision: 'allow' });
      await waitFor(async () => (await records()).some(row => row.channel === 'chat:event:batch' && (row.value as Array<Record<string, Json>>).some(event => event.sessionId === info.id && event.type === 'done')), 30000, 'approved turn completed');
      assert(!existsSync(target), 'approved tool really ran: ' + JSON.stringify(await invoke('session:history', { sessionId: info.id })));
      await assertRejects(() => invoke('permission:respond', { requestId: card.requestId!, decision: 'allow' }), 'duplicate UI answer refused');
    });
    await h.test('plugin changes preserve running tasks and load exactly once after a complete host restart', async () => {
      const market = join(root, 'gui-market'), packageDir = join(market, 'plugins/gui-plugin');
      mkdirSync(join(market, '.claude-plugin'), { recursive: true }); mkdirSync(join(packageDir, '.claude-plugin'), { recursive: true });
      mkdirSync(join(packageDir, 'skills/gui-plugin-skill'), { recursive: true });
      writeFileSync(join(market, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'gui', plugins: [{ name: 'gui-plugin', source: './plugins/gui-plugin' }] }));
      writeFileSync(join(packageDir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'gui-plugin', version: '1.0.0', description: 'Disposable plugin fixture', skills: ['./skills'] }));
      writeFileSync(join(packageDir, 'skills/gui-plugin-skill/SKILL.md'), '---\nname: gui-plugin-skill\ndescription: Disposable plugin skill\n---\nUse only in this test.\n');
      await desktop.sessions.request('config/batchWrite', { edits: [{ keyPath: 'marketplaces.gui', value: { installLocation: market }, mergeStrategy: 'replace' }] });
      const catalog = await invoke('plugins:market') as {plugins:Array<{id:string}>};
      assert(catalog.plugins.some(plugin => plugin.id === 'gui-plugin@gui'), 'settings list includes fixture catalog');
      writeFileSync(target, 'A disposable plugin activation fixture.');
      const busy = await invoke('session:new') as {id:string};
      await invoke('chat:send', { sessionId: busy.id, text: 'APPROVAL FIXTURE' });
      await waitFor(async () => (await records()).some(row => row.channel === 'permission:request' && (row.value as Record<string, Json>).sessionId === busy.id), 30000, 'a task is waiting for an explicit approval');
      const pid = desktop.engine.inspect()[0]?.pid;
      assertEqual((await invoke('plugins:install', { id: 'gui-plugin@gui' }) as {ok:boolean}).ok, true, 'engine persisted installation');
      assertEqual((await invoke('plugins:market') as {restartRequired:boolean}).restartRequired, true, 'settings exposes the pending application restart');
      assertEqual(desktop.engine.inspect()[0]?.pid, pid, 'install did not replace the running engine');
      assertEqual((await invoke('session:list') as Array<{id:string;isWorking:boolean}>).find(row => row.id === busy.id)?.isWorking, true, 'the existing task remains active');
      const before = await invoke('session:new') as {id:string};
      const pending = await invoke('plugins:list', { sessionId: before.id }) as Array<{id:string;runtime:{effectiveStatus:string}}>;
      assertEqual(pending.find(plugin => plugin.id === 'gui-plugin@gui')?.runtime?.effectiveStatus, 'pending_restart', 'new sessions accurately report the unchanged endpoint registry: ' + JSON.stringify(pending));
      const card = (await records()).find(row => row.channel === 'permission:request' && (row.value as Record<string, Json>).sessionId === busy.id)!.value as Record<string, Json>;
      await invoke('permission:respond', { requestId: card.requestId!, decision: 'allow' });
      await waitFor(async () => !(await invoke('session:list') as Array<{id:string;isWorking:boolean}>).find(row => row.id === busy.id)?.isWorking, 10000, 'the task completes on its original engine');
      await invoke('session:delete', { sessionId: before.id });
      const reopen = async (): Promise<void> => {
        const previous = desktop;
        await previous.shutdown();
        assertEqual(previous.engine.liveProcessCount(), 0, 'the prior engine exits before creating its replacement');
        runtime = await createDesktopRuntime(app, { show: false, tray: false, notificationFixture, nativeFixtureAddonPath: join(process.env.KLAUS_WHATSAPP_FIXTURE_DIR!, `klaus-native-${process.platform}-${process.arch}.node`), externalImportHome });
        desktop = runtime;
        desktop.engine.on('event', event => engineEvents.push(event));
        await waitFor(() => desktop.window.webContents.executeJavaScript("Boolean(window.klaus && window.__KLAUS_DESKTOP__)"), 15000, 'the replacement application loaded its real frontend');
        await waitFor(() => desktop.window.webContents.executeJavaScript("!document.getElementById('boot-screen') || getComputedStyle(document.getElementById('boot-screen')).display === 'none'"), 15000, 'the replacement workbench finished startup');
        assertEqual((await invoke('plugins:market') as {restartRequired:boolean}).restartRequired, false, 'the new endpoint loaded the saved registry');
      };
      await reopen();
      const row = await invoke('session:new') as {id:string};
      const view = await invoke('runtime:extensions', { sessionId: row.id }) as {status:string;extensions:{skills:Array<{name:string;source:{kind:string}}>}};
      assertEqual(view.status, 'ready', 'actual runtime view available');
      const skills = view.extensions.skills.filter(skill => skill.name.includes('gui-plugin-skill'));
      assertEqual(skills.length, 1, 'plugin skill registered exactly once');
      assertEqual(skills[0]?.source.kind, 'plugin', 'engine owns plugin attribution');
      assertEqual((await invoke('plugins:toggle', { id: 'gui-plugin@gui', enabled: false }) as {ok:boolean}).ok, true, 'persisted disable acknowledged');
      assertEqual((await invoke('plugins:list', { sessionId: row.id }) as Array<{id:string;enabled:boolean}>).find(plugin => plugin.id === 'gui-plugin@gui')?.enabled, false, 'settings reflects engine desired state');
      assertEqual((await invoke('plugins:uninstall', { id: 'gui-plugin@gui' }) as {removed:boolean}).removed, true, 'engine removed its installation');
      assert(existsSync(packageDir), 'marketplace source retained');
      await invoke('session:delete', { sessionId: row.id });
      await reopen();
      const removed = await invoke('session:new') as {id:string};
      const after = await invoke('runtime:extensions', { sessionId: removed.id }) as {extensions:{skills:Array<{name:string}>}};
      assertEqual(after.extensions.skills.filter(skill => skill.name.includes('gui-plugin-skill')).length, 0, 'uninstalled contributions are absent after restart');
      await invoke('session:delete', { sessionId: removed.id });
    });
    await h.test('closing the main window keeps the engine; shutdown closes both', async () => {
      await desktop.window.webContents.executeJavaScript('window.klausNewTerminal()');
      assertEqual(desktop.nativeCounts().ptys, 1, 'a running terminal participates in shutdown');
      desktop.window.close();
      assertEqual(desktop.window.isDestroyed(), false, 'main window remains available');
      assertEqual(desktop.window.isVisible(), false, 'main window is hidden');
      assertEqual(desktop.engine.liveProcessCount(), 1, 'background engine remains owned');
      assertEqual(desktop.nativeCounts().ptys, 1, 'hide keeps the terminal alive');
      const preparing = desktop.prepareUpdate();
      assertEqual(desktop.prepareUpdate(), preparing, 'concurrent update preparation shares the real drain');
      await preparing;
      assertEqual(desktop.window.isDestroyed(), false, 'renderer remains available until every native ACK is delivered');
      assertEqual(desktop.engine.liveProcessCount(), 0, 'update preparation has stopped the single engine');
      assertEqual(desktop.nativeCounts().ptys, 0, 'update preparation has drained all terminal delivery');
      autoUpdater.emit('before-quit-for-update');
      desktop.window.close();
      await waitFor(() => desktop.window.isDestroyed(), 5000, 'prepared native updater window close is not converted into hide');
      const shutdown = desktop.shutdown();
      assertEqual(desktop.shutdown(), shutdown, 'concurrent shutdown shares completion');
      await shutdown;
      assertEqual(desktop.engine.liveProcessCount(), 0, 'engine exited before shutdown resolved');
      assertEqual(desktop.nativeCounts().ptys, 0, 'native PTYs have been released');
      assertEqual(desktop.window.isDestroyed(), true, 'application window destroyed');
    });
    await h.test('local data reset waits for the actual engine and terminal before deleting files and handing off restart', async () => {
      let restartRequests = 0;
      runtime = await createDesktopRuntime(app, { show: false, tray: false, notificationFixture, nativeFixtureAddonPath: join(process.env.KLAUS_WHATSAPP_FIXTURE_DIR!, `klaus-native-${process.platform}-${process.arch}.node`), externalImportHome, restartAfterWipeLocal: () => { restartRequests++; } }); desktop = runtime;
      await waitFor(() => desktop.window.webContents.executeJavaScript('Boolean(window.klaus && window.klausNewTerminal)'), 15_000, 'reset fixture frontend ready');
      const config = readFileSync(join(root, 'config.toml'), 'utf8');
      await invoke('settings:kv:set', { key: 'reset-fixture', value: 'owned' });
      const row = object(await invoke('session:new')), id = String(row.id);
      mkdirSync(join(root, 'sessions', id), { recursive: true }); writeFileSync(join(root, 'sessions', id, 'reset-owned.txt'), 'owned');
      for (const directory of ['transcripts', 'uploads']) { mkdirSync(join(root, directory), { recursive: true }); writeFileSync(join(root, directory, 'reset-owned.txt'), 'owned'); }
      writeFileSync(join(root, 'reset-preserved.txt'), 'preserve');
      await desktop.window.webContents.executeJavaScript('window.klausNewTerminal()');
      assertEqual(desktop.nativeCounts().ptys, 1, 'an actual terminal participates in reset');
      assertEqual(desktop.engine.liveProcessCount(), 1, 'the only engine is live before reset');
      assertEqual(object(await invoke('klausAuth:wipeLocal')).ok, true, 'the actual renderer reset invoke completes');
      assertEqual(restartRequests, 1, 'restart is requested only after cleanup');
      assertEqual(desktop.engine.liveProcessCount(), 0, 'the engine exited before any successful reset reply'); assertEqual(desktop.nativeCounts().ptys, 0, 'native writers have been drained');
      for (const name of ['settings.db', 'settings.db-wal', 'settings.db-shm', 'sessions', 'transcripts', 'uploads']) assert(!existsSync(join(root, name)), 'only the authorized target was removed: ' + name);
      assertEqual(readFileSync(join(root, 'config.toml'), 'utf8'), config, 'engine configuration and model source settings remain');
      assertEqual(readFileSync(join(root, 'reset-preserved.txt'), 'utf8'), 'preserve', 'unrelated profile files remain');
      await assertRejects(() => invoke('settings:kv:set', { key: 'reset-fixture', value: 'late' }), 'old renderer cannot reopen the settings database');
      await desktop.shutdown();
      assert(!existsSync(join(root, 'settings.db')), 'final teardown does not recreate deleted data');
      runtime = await createDesktopRuntime(app, { show: false, tray: false, notificationFixture, nativeFixtureAddonPath: join(process.env.KLAUS_WHATSAPP_FIXTURE_DIR!, `klaus-native-${process.platform}-${process.arch}.node`), externalImportHome }); desktop = runtime;
      await waitFor(() => desktop.window.webContents.executeJavaScript('Boolean(window.klaus && window.__KLAUS_DESKTOP__)'), 15_000, 'the post-reset application starts');
      assertEqual(await invoke('settings:kv:get', { key: 'reset-fixture' }), null, 'the new runtime has clean client settings');
      assert(!JSON.stringify(await invoke('session:list')).includes(id), 'deleted history cannot reappear on startup');
    });
  } catch (error) {
    await h.test('application integration setup', () => { throw error; });
  } finally {
    try { await runtime?.shutdown(); }
    catch (error) {
      if (existsSync(join(root, 'electron-host.log'))) writeFileSync(join(__dirname, 'desktop-app-cleanup-host.jsonl'), readFileSync(join(root, 'electron-host.log')));
      await h.test('application cleanup', () => { throw error; });
    }
    for (const outcome of await Promise.allSettled([provider?.close(), mcpOAuth?.close(), discord?.close(), wecom?.close(), qq?.close(), dingtalk?.close(), feishu?.close(), device?.close(), whatsapp?.close()])) {
      if (outcome.status === 'rejected') await h.test('fixture cleanup', () => { throw outcome.reason; });
    }
    if (sshFixture && sshFixture.exitCode === null) sshFixture.kill();
    await sshExited;
    const code = await h.finish(join(__dirname, 'desktop-app-result.json'), 'desktop-app');
    app.exit(code);
  }
})();
