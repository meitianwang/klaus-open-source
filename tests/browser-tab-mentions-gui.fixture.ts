import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BrowserManager, type BrowserPage } from '../main/browser/manager';
import { BrowserMcpServer } from '../main/browser/mcp';
import { registerBrowserHandlers } from '../main/ipc/handlers/browser';
import { ChannelRegistry } from '../main/ipc/registry';
import { object, type BrowserObject } from '../main/browser/types';
import type { Json } from '../main/ipc/contract';
import { assert, assertDeepEqual, assertEqual, Harness, waitFor } from './harness';

const root = process.env.KLAUS_TAB_MENTION_TEST_ROOT;
const profile = process.env.KLAUS_TAB_MENTION_TEST_PROFILE;
if (!root || !profile || !resolve(profile).startsWith(resolve(root) + '/')) throw new Error('An isolated fixture root and child profile are required.');
const outputRoot = root;
const isolatedProfile = profile;
mkdirSync(isolatedProfile, { recursive: true });
app.setPath('userData', isolatedProfile);
app.on('window-all-closed', () => {});

async function main(): Promise<number> {
  await app.whenReady();
  const h = new Harness();
  const icon = `data:image/png;base64,${nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 255), { width: 16, height: 16 }).toPNG().toString('base64')}`;
  const server = createServer((request, response) => {
    const name = (request.url || '/').slice(1);
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><title>Notes ${name}</title>${name === 'Echo' ? '' : `<link rel="icon" href="${icon}">`}<main>Owned page ${name}</main>`);
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); assert(address && typeof address !== 'string', 'loopback page fixture address');
  const base = `http://127.0.0.1:${address.port}`;
  const window = new BrowserWindow({ width: 1000, height: 800, show: false, title: 'Klaus browser mention regression',
    webPreferences: { preload: join(__dirname, 'browser-tab-mentions-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const calls: Array<{ channel: string; request: BrowserObject; response: BrowserObject }> = [];
  const blockedUiRequests: string[] = [];
  let enabled = true;
  const manager = new BrowserManager({ window, configRoot: isolatedProfile, enabled: () => enabled,
    emit: (channel, payload) => { if (!window.isDestroyed()) window.webContents.send(channel, payload); } });
  const mcp = new BrowserMcpServer(manager, { chromeDiscoveryDirectory: join(isolatedProfile, 'chrome-discovery') });
  const registry = new ChannelRegistry();
  registerBrowserHandlers(registry, { manager, chrome: mcp.chrome });
  ipcMain.handle('browser-use:mention-tabs', async (event, request: Json) => {
    const handler = registry.lookup('browser-use:mention-tabs'); assert(handler, 'production mention handler registered');
    const answer = object(await handler({ role: 'main', senderId: event.sender.id, channel: 'browser-use:mention-tabs', args: [request] }));
    calls.push({ channel: 'browser-use:mention-tabs', request: object(request), response: answer });
    return answer;
  });
  const pages: BrowserPage[] = [];
  const evaluate = (expression: string): Promise<any> => window.webContents.executeJavaScript(expression, true);
  const snapshot = () => evaluate('browserTabFixture.snapshot()');
  const command = (method: string, fields: BrowserObject) => window.webContents.debugger.sendCommand(method, fields);
  const query = async (text: string, owner: string | null = 'mention-A'): Promise<void> => {
    await evaluate(`browserTabFixture.prepare(${JSON.stringify(owner)})`);
    await command('Input.insertText', { text: '@' + text });
  };
  const key = async (value: 'ArrowDown' | 'Enter'): Promise<void> => {
    for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: value, code: value, windowsVirtualKeyCode: value === 'Enter' ? 13 : 40 });
  };
  const rowsReady = (count: number) => waitFor(async () => (await snapshot()).rows.length === count, 7000, `${count} actual menu tab rows`);
  let rpcId = 0;
  const rpc = async (endpoint: string, method: string, params: BrowserObject = {}): Promise<BrowserObject> => {
    const reply = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    assertEqual(reply.status, 200, 'MCP HTTP status'); return object(await reply.json());
  };
  const endpoint = async (owner: string): Promise<string> => {
    const servers = (await mcp.hostCapabilities(owner)).mcpServers;
    assert(Array.isArray(servers) && servers.length > 0, 'task MCP capability exists');
    return String(object(servers[0]).url);
  };
  try {
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const cancel = !details.url.startsWith('file:') && !details.url.startsWith('data:');
      if (cancel) blockedUiRequests.push(details.url);
      callback({ cancel });
    });
    window.webContents.on('console-message', event => { if (event.level === 'error') process.stderr.write(`renderer: ${event.message}\n`); });
    await window.loadFile(join(__dirname, 'index.html'));
    window.webContents.debugger.attach('1.3');
    window.showInactive();
    await waitFor(async () => await evaluate('Boolean(window.browserTabFixture?.ready)'), 7000, 'production menu island ready');
    manager.setConversation('mention-A');
    for (const title of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']) {
      process.stdout.write(`creating actual IAB page ${title}\n`);
      const page = await manager.createTab('mention-A', `${base}/${title}`); pages.push(page);
      await waitFor(() => page.native.getTitle() === `Notes ${title}`, 5000, `real page title ${title}`);
    }
    await manager.createTab('mention-B', `${base}/Foreign`);
    const alpha = pages[0]!, delta = pages[3]!;
    assertEqual(app.getPath('userData'), isolatedProfile, 'isolated app profile');
    assert(manager.profilePath.startsWith(resolve(isolatedProfile) + '/'), 'isolated IAB profile');
    await waitFor(() => !!alpha.faviconUrl, 5000, 'real page favicon update');
    await h.test('real @ menu lists only three recent task tabs and search reaches older tabs', async () => {
      await query(''); await rowsReady(3);
      let value = await snapshot();
      assertEqual(value.trustedInput, true, 'native input event is trusted');
      assertDeepEqual(value.rows.map((row: any) => row.text.split('127.')[0]), ['Notes Echo', 'Notes Delta', 'Notes Charlie'], 'recent ordering');
      assert(value.rows.every((row: any) => !row.tooltip), 'tab rows do not inject hover tooltips');
      await query('notes'); await rowsReady(5);
      value = await snapshot(); assert(!value.rows.some((row: any) => row.text.includes('Foreign')), 'foreign conversation is excluded');
      writeFileSync(join(outputRoot, 'menu-open.png'), (await window.webContents.capturePage()).toPNG());
      await query('notes alpha'); await rowsReady(1);
      assert((await snapshot()).rows[0].text.includes('Alpha'), 'multiword title search reaches older tab');
      assert(calls.some(call => call.request.query === 'notes' && Array.isArray(call.response.tabs) && call.response.tabs.length === 5), 'registered handler supplies actual search candidates');
    });
    await h.test('native click inserts a saved browser chip and history metadata restores it', async () => {
      const point = await evaluate('browserTabFixture.point(0)');
      for (const type of ['mousePressed', 'mouseReleased']) await command('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
      const value = await snapshot();
      assertEqual(value.selections.at(-1).trusted, true, 'native pointer selection');
      assertEqual(value.draft.references[0].browserTab.tabId, String(alpha.handle), 'selected real tab handle');
      assert(value.preview.includes('composer-reference-pill') && !value.preview.includes('plugin://'), 'chip hides protocol URI');
      const restored = await evaluate('browserTabFixture.reloadDraft()'); assertDeepEqual(restored, value.draft, 'saved draft round-trip');
      const replay = await evaluate('browserTabFixture.replay()');
      assertDeepEqual(replay.restored.references, value.draft.references, 'history edit restores full browser snapshot');
      assert(replay.html.includes('Notes Alpha') && !replay.html.includes('plugin://'), 'production history helper renders saved chip');
      writeFileSync(join(outputRoot, 'selected-chip.png'), (await window.webContents.capturePage()).toPNG());
    });
    await h.test('native keyboard selection follows tab identity across a real recency update', async () => {
      await query('notes'); await rowsReady(5); await key('ArrowDown');
      let value = await snapshot(); assert(value.rows.find((row: any) => row.selected).text.includes('Delta'), 'keyboard selected second recent tab');
      manager.selectTab('mention-A', alpha.handle);
      await waitFor(async () => (await snapshot()).rows[0].text.includes('Alpha'), 5000, 'IAB push updates recent order');
      value = await snapshot(); assert(value.rows.find((row: any) => row.selected).text.includes('Delta'), 'selection stays on the same tab');
      await key('Enter'); value = await snapshot();
      assertEqual(value.selections.at(-1).trusted, true, 'native keyboard selection');
      assertEqual(value.draft.references[0].browserTab.tabId, String(delta.handle), 'keyboard inserts the intended tab');
    });
    await h.test('real favicon data remains bounded and disabled notice is localized without suppressing retry', async () => {
      await query('notes'); await rowsReady(5);
      const value = await snapshot();
      const images = value.rows.flatMap((row: any) => row.icons);
      assert(images.length > 0 && images.every((image: any) => image.bounded && image.src.length <= 16384), 'menu uses only bounded data icons');
      const missingIcon = value.rows.find((row: any) => row.text.includes('Echo'));
      assert(missingIcon.icons.length === 0 && missingIcon.fallback, 'a real tab with no favicon renders the browser icon');
      assertDeepEqual(blockedUiRequests, [], 'menu never attempts a remote favicon request');
      enabled = false; manager.publish();
      await waitFor(async () => (await snapshot()).state.some((text: string) => text.includes('请在设置中开启浏览器')), 5000, 'localized disabled reason');
      assert((await snapshot()).state.some((text: string) => text.includes('重试')), 'retry stays available');
      enabled = true; manager.publish();
      await rowsReady(5);
      await query('', null);
      await waitFor(() => calls.at(-1)?.request.sessionId === null, 5000, 'fresh conversation request');
      await rowsReady(0);
    });
    await h.test('named HTTP MCP resolve_tab returns the live owned target and refuses stale foreign or closed references', async () => {
      await query('notes delta'); await rowsReady(1);
      await key('Enter'); const reference = (await snapshot()).draft.references[0].browserTab;
      const ownerEndpoint = await endpoint('mention-A'), foreignEndpoint = await endpoint('mention-B');
      assert(object((await rpc(ownerEndpoint, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mention-gui-fixture', version: '1' } })).result).serverInfo, 'actual MCP initialization');
      const tools = object((await rpc(ownerEndpoint, 'tools/list')).result).tools as Json[];
      assert(tools.some(tool => object(tool).name === 'resolve_tab'), 'named production MCP tool is listed');
      const resolveMention = async (url: string): Promise<BrowserObject> => object((await rpc(url, 'tools/call', { name: 'resolve_tab', arguments: { mention: reference.mention } })).result);
      const resolved = await resolveMention(ownerEndpoint);
      assertEqual(resolved.isError, undefined, 'owned live mention resolves');
      assertDeepEqual(object(object(resolved.structuredContent).value), { browserId: 'iab', tabId: delta.handle, title: reference.title, url: reference.url }, 'executable target');
      assertEqual(await manager.page('mention-A', delta.handle).cdp.evaluate('document.querySelector("main").textContent'), 'Owned page Delta', 'target is the actual live WebContentsView');
      assertEqual(await delta.cdp.evaluate('typeof window.klaus'), 'undefined', 'remote browser page receives no host bridge');
      const before = manager.listPages('mention-A').map(page => ({ id: page.handle, url: page.native.getURL() }));
      assertEqual((await resolveMention(foreignEndpoint)).isError, true, 'foreign task cannot resolve');
      await delta.cdp.evaluate('document.title = "Changed title"');
      await waitFor(() => delta.native.getTitle() === 'Changed title', 3000, 'actual title changed');
      assertEqual((await resolveMention(ownerEndpoint)).isError, true, 'stale snapshot cannot resolve');
      assertDeepEqual(manager.listPages('mention-A').map(page => ({ id: page.handle, url: page.native.getURL() })), before, 'refusal does not navigate or create a replacement');
      await manager.navigate(delta, `${base}/Moved`);
      assertEqual((await resolveMention(ownerEndpoint)).isError, true, 'changed URL cannot resolve');
      assertEqual(delta.native.getURL(), `${base}/Moved`, 'URL refusal does not navigate back to snapshot');
      manager.closeTab('mention-A', delta.handle);
      assertEqual((await resolveMention(ownerEndpoint)).isError, true, 'closed tab cannot resolve');
      assertEqual(manager.listPages('mention-A').length, before.length - 1, 'closed reference does not create replacement');
    });
    writeFileSync(join(outputRoot, 'ui.png'), (await window.webContents.capturePage()).toPNG());
    writeFileSync(join(outputRoot, 'handler-calls.json'), JSON.stringify(calls, null, 2));
    return await h.finish(join(outputRoot, 'result.json'), 'browser-tab-mentions-gui');
  } finally {
    ipcMain.removeHandler('browser-use:mention-tabs');
    await mcp.shutdown(); manager.dispose();
    if (!window.isDestroyed()) window.destroy();
    server.closeAllConnections(); await new Promise<void>(close => server.close(() => close()));
  }
}
main().then(code => app.exit(code)).catch(error => { process.stderr.write(`${error.stack || error}\n`); app.exit(1); });
