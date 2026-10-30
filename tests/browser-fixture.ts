import { app, BaseWindow, BrowserWindow, nativeImage, session, webContents } from 'electron';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { BrowserManager, type BrowserPage } from '../main/browser/manager';
import { RunPreview } from '../main/browser/run-preview';
import { BrowserMcpServer } from '../main/browser/mcp';
import { registerBrowserHandlers } from '../main/ipc/handlers/browser';
import { ChannelRegistry } from '../main/ipc/registry';
import { object, type BrowserObject } from '../main/browser/types';
import type { Json } from '../main/ipc/contract';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, waitFor } from './harness';
import { registerAdvancedBrowserTests, serveAdvancedFixture } from './browser-advanced-cases';

const profile = process.env.KLAUS_BROWSER_FIXTURE_PROFILE;
if (!profile) throw new Error('This fixture requires an isolated KLAUS_BROWSER_FIXTURE_PROFILE.');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('site-per-process');
app.on('window-all-closed', () => {});

async function main(): Promise<number> {
  await app.whenReady();
  const h = new Harness();
  const fixture = createServer((request, response) => {
    if (serveAdvancedFixture(request, response, `http://127.0.0.1:${port}`)) return;
    if (request.url === '/download') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="fixture.txt"' }); response.end('browser fixture download'); return;
    }
    if (request.url === '/page.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end("document.querySelector('#count').onclick=()=>{document.querySelector('#result').textContent=String(Number(document.querySelector('#result').textContent)+1)};document.querySelector('#popup').onclick=()=>{window.popupClicked=true;window.popupOpened=!!window.open('/popup')};console.log('fixture loaded');"); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self' http://localhost:*;", 'Set-Cookie': 'browser_fixture=present; Path=/; SameSite=Lax' });
    response.end(`<!doctype html><title>${request.url}</title><style>body{margin:20px;background:#e4f0fb}input,button{font:20px sans-serif;margin:8px;padding:8px}iframe{width:300px;height:100px}</style><h1>${request.url}</h1><input id="input" aria-label="Fixture input"><button id="count">Increment</button><span id="result">0</span><button id="popup">Open popup</button><script src="/page.js"></script>${request.url === '/iframe' ? `<iframe src="http://localhost:${port}/frame"></iframe><iframe src="/same-frame"></iframe>` : ''}`);
  });
  let port = 0;
  await new Promise<void>(resolveListen => fixture.listen(0, '127.0.0.1', resolveListen));
  const address = fixture.address();
  assert(address && typeof address !== 'string', 'fixture server has a port');
  port = address.port;
  const base = `http://127.0.0.1:${port}`;
  const window = new BrowserWindow({ width: 900, height: 700, show: false, title: 'Klaus browser fixture', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{background:#fff;color:#111}</style><h1>Klaus browser fixture</h1>'));
  window.showInactive();
  const pushes: Array<{ channel: string; payload: Json }> = [];
  let enabled = true;
  let acknowledgePanelOpen = true;
  let observePanelOpen: ((payload: BrowserObject) => void) | undefined;
  let manager!: BrowserManager;
  manager = new BrowserManager({
    window, configRoot: profile!, enabled: () => enabled, dialogTimeoutMs: 3000,
    emit: (channel, payload) => {
      pushes.push({ channel, payload });
      if (channel === 'browser-use:open-panel') {
        const observer = observePanelOpen;
        observePanelOpen = undefined;
        observer?.(object(payload));
        if (acknowledgePanelOpen) queueMicrotask(() => { void manager.show(object(payload)).catch(() => {}); });
      }
    },
  });
  const mcp = new BrowserMcpServer(manager);
  const preview = new RunPreview(manager, (sessionId, toolCallId) => pushes.push({ channel: 'run-preview:changed', payload: { sessionId, toolCallId } }));
  const operations = mcp.operations;
  const registry = new ChannelRegistry();
  registerBrowserHandlers(registry, { manager, preview, getSettings: () => ({ enabled, chromeEnabled: false }) });
  const invoke = async (channel: string, payload: Json = {}): Promise<BrowserObject> => {
    const handler = registry.lookup(channel); assert(handler, `${channel} is registered`);
    return object(await handler({ role: 'main', senderId: window.webContents.id, channel, args: [payload] }));
  };
  const response = (answer: BrowserObject): BrowserObject => {
    assert(answer.isError !== true, `browser operation: ${JSON.stringify(answer.error)}`);
    return object(answer.structuredContent);
  };
  let pageA: BrowserPage;
  let pageB: BrowserPage;
  let endpointA = '';
  let endpointB = '';
  let mcpSession = '';
  const rpc = async (url: string, method: string, params: BrowserObject = {}, headers: Record<string, string> = {}): Promise<{ status: number; body: BrowserObject; sessionId: string }> => {
    const result = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: result.status, body: object(await result.json()), sessionId: result.headers.get('mcp-session-id') ?? '' };
  };

  h.test('UI creates an actual sandboxed WebContentsView and receives the current tab contract', async () => {
    assertEqual((await invoke('browser-use:set-conversation', { conversationId: 'A' })).ok, true, 'set conversation');
    const created = await invoke('browser-use:tabs', { action: 'new', url: `${base}/one` });
    assertEqual(created.ok, true, `create tab: ${JSON.stringify(created)}`);
    pageA = manager.page('A');
    assertEqual(object(created.state).tabId, pageA.id, 'UI opaque id');
    assertEqual(object((created.tabs as Json[])[0]).id, pageA.id, 'tab rows use id');
    const shown = await invoke('browser-use:show', { sessionId: 'A', focusRevision: manager.focusRevision, bounds: { x: 100, y: 100, width: 700, height: 500 } });
    assertEqual(shown.ok, true, 'show');
    assert(window.contentView.children.includes(pageA.view), 'native view attached');
    assertDeepEqual(pageA.view.getBounds(), { x: 100, y: 100, width: 700, height: 500 }, 'view bounds');
    const globals = await pageA.cdp.evaluate('({require:typeof require,process:typeof process,klaus:typeof window.klaus,host:typeof window.__KLAUS_DESKTOP__})');
    assertDeepEqual(globals, { require: 'undefined', process: 'undefined', klaus: 'undefined', host: 'undefined' }, 'remote page has no host bridge');
  });

  const nextPanelOpen = (): Promise<BrowserObject> => new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => {
      observePanelOpen = undefined;
      rejectOpen(new Error('browser-use:open-panel was not emitted within 3000ms'));
    }, 3000);
    observePanelOpen = payload => {
      clearTimeout(timer);
      resolveOpen(payload);
    };
  });

  h.test('visual operations always request the renderer and wait for its native-panel acknowledgement', async () => {
    manager.hide();
    acknowledgePanelOpen = false;
    let settled = false;
    let pendingOperation: Promise<BrowserObject> | undefined;
    const opening = nextPanelOpen();
    pendingOperation = operations.execute('A', 'navigate', { url: `${base}/acknowledged` }).finally(() => { settled = true; });
    try {
      const request = await opening;
      assertEqual(settled, false, 'tool result waits while the renderer lays out the panel');
      await manager.show(request);
      response(await pendingOperation);
      pendingOperation = undefined;
      assertEqual(manager.state('A').visible, true, 'renderer show acknowledges the same native page');

      settled = false;
      const reopening = nextPanelOpen();
      pendingOperation = operations.execute('A', 'reload', {}).finally(() => { settled = true; });
      const reopenRequest = await reopening;
      assertEqual(settled, false, 'an already attached page still waits for the renderer to select the Browser surface');
      await manager.show(reopenRequest);
      response(await pendingOperation);
      pendingOperation = undefined;
    } finally {
      acknowledgePanelOpen = true;
      observePanelOpen = undefined;
      if (pendingOperation) await pendingOperation;
    }
  });

  h.test('native input and agent input operate on the identical page', async () => {
    await waitFor(() => { app.focus({ steal: true }); window.focus(); return window.isFocused(); }, 3000, 'fixture window focused for native input');
    pageA.view.webContents.focus();
    await pageA.cdp.evaluate("document.querySelector('#input').focus()");
    await waitFor(async () => await pageA.cdp.evaluate('document.hasFocus()') === true, 2000, 'native page has focus');
    await waitFor(async () => {
      if (await pageA.cdp.evaluate("document.querySelector('#input').value") === 'h') return true;
      // Other GUI fixtures may become key while this async test is awaiting.
      // sendInputEvent requires a focused owning window; reacquire before typing.
      app.focus({ steal: true }); window.focus(); pageA.view.webContents.focus();
      await pageA.cdp.evaluate("document.querySelector('#input').focus()");
      if (!window.isFocused() || !pageA.view.webContents.isFocused()) return false;
      pageA.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'H' });
      pageA.view.webContents.sendInputEvent({ type: 'char', keyCode: 'h' });
      pageA.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'H' });
      return await pageA.cdp.evaluate("document.querySelector('#input').value") === 'h';
    }, 3000, 'native input reached page');
    response(await operations.execute('A', 'type', { selector: '#input', text: '人工' }));
    const answer = response(await operations.execute('A', 'eval', { expression: "document.querySelector('#input').value" }));
    assertEqual(answer.value, 'h人工', 'agent reads native and CDP input on same WebContents');
    response(await operations.execute('A', 'click', { selector: '#count' }));
    assertEqual(await pageA.cdp.evaluate("document.querySelector('#result').textContent"), '1', 'trusted Chromium click reached event listener');
  });

  h.test('snapshot refs, clear typing and screenshots preserve real results and toolSurface', async () => {
    const snapshot = response(await operations.execute('A', 'snapshot', {}));
    const nodes = object(snapshot.value).nodes as Json[];
    const input = nodes.map(object).find(node => node.tag === 'input');
    assert(typeof input?.ref === 'string', 'snapshot returns an input ref');
    response(await operations.execute('A', 'type', { ref: input.ref, text: 'replaced', clear: true }));
    assertEqual(await pageA.cdp.evaluate("document.querySelector('#input').value"), 'replaced', 'clear typing replaces selected text');
    const refreshed = object(response(await operations.execute('A', 'snapshot', {})).value).nodes as Json[];
    assertEqual(refreshed.map(object).find(node => node.tag === 'input')?.ref, input.ref, 'the same live node keeps its ref across snapshots');
    await pageA.cdp.evaluate("(()=>{const old=document.querySelector('#input'),next=old.cloneNode(true);next.value=old.value;old.replaceWith(next);return true})()");
    assertEqual((await operations.execute('A', 'type', { ref: input.ref, text: 'stale' })).isError, true, 'a removed node ref cannot address its replacement');
    const capture = await operations.execute('A', 'screenshot', {});
    const dataUrl = object(response(capture).value).dataUrl;
    assert(typeof dataUrl === 'string' && dataUrl.startsWith('data:image/jpeg;base64,'), 'default capture is a JPEG');
    assert((capture.content as Json[]).some(block => object(block).type === 'image'), 'MCP image content is present');
    const surface = object(object(capture._meta)['klaus/toolSurface']);
    assertEqual(surface.targetId, pageA.cdp.targetId, 'actual page target');
    assertEqual(surface.tabId, String(pageA.handle), 'numeric tool handle is separate from UI id');
    assertEqual(object(surface.screenshot).url, dataUrl, 'preview reuses the same capture');
    const savedValue = object(response(capture).value);
    assertEqual(savedValue.saved, true, 'ordinary capture persists by default');
    assert(typeof savedValue.path === 'string', 'the model receives the actual saved path');
    assert(readFileSync(savedValue.path).equals(Buffer.from(dataUrl.split(',')[1]!, 'base64')), 'saved artifact retains the captured original bytes');
    assert((capture.content as Json[]).some(block => String(object(block).text).includes('Saved: ' + JSON.stringify(savedValue.path))), 'saved path is model-visible text');
    const before = readdirSync(dirname(savedValue.path)).length;
    const observation = await operations.execute('A', 'screenshot', { save: false, format: 'png' });
    const transient = object(response(observation).value);
    assertEqual(transient.saved === true, false, 'explicit observation remains transient');
    assertEqual(transient.path, undefined, 'observation does not invent a file path');
    assert(String(transient.dataUrl).startsWith('data:image/png;base64,'), 'requested format retains original PNG pixels');
    assert((observation.content as Json[]).some(block => object(block).type === 'image'), 'transient image remains usable by the model');
    assertEqual(readdirSync(dirname(savedValue.path)).length, before, 'save:false does not create a persistent artifact');
    writeFileSync(join(__dirname, 'browser-fixture.jpg'), Buffer.from(dataUrl.split(',')[1]!, 'base64'));
  });

  h.test('typed locator requests reach real controls by accessible criteria', async () => {
    const before = Number(await pageA.cdp.evaluate("document.querySelector('#result').textContent"));
    response(await operations.execute('A', 'browser_locator', {
      operation: { type: 'locator', selector: '', action: 'click', options: { role: 'button', text: 'Increment', exact: true } },
    }));
    assertEqual(await pageA.cdp.evaluate("document.querySelector('#result').textContent"), String(before + 1), 'typed accessible locator clicks the control');
    response(await operations.execute('A', 'browser_locator', {
      operation: { type: 'locator', selector: '', action: 'fill', value: 'Typed request', options: { label: 'Fixture input' } },
    }));
    assertEqual(await pageA.cdp.evaluate("document.querySelector('#input').value"), 'Typed request', 'typed label locator fills the input');
    // The remaining fixture verifies that this original value survives overlays.
    response(await operations.execute('A', 'type', { selector: '#input', text: 'replaced', clear: true }));
  });

  h.test('browser computer scroll reaches an inner document without a coordinate', async () => {
    await pageA.cdp.evaluate("(()=>{const box=document.createElement('div');box.id='scroll-box';box.style.cssText='position:fixed;left:20%;top:10%;width:60%;height:300px;overflow:auto;z-index:10;background:white';box.innerHTML='<div style=\"height:1600px\">Scrollable document</div>';document.body.append(box);return true})()");
    try {
      assertEqual(await pageA.cdp.evaluate("document.querySelector('#scroll-box').scrollTop"), 0, 'inner document starts at the top');
      response(await operations.execute('A', 'computer', { action: 'scroll', amount: 2 }));
      await waitFor(async () => Number(await pageA.cdp.evaluate("document.querySelector('#scroll-box').scrollTop")) > 0, 3000, 'wheel reached the inner document');
    } finally {
      await pageA.cdp.evaluate("document.querySelector('#scroll-box')?.remove()");
    }
  });

  h.test('overlay hides and restores the native view without recreating the page', async () => {
    const identity = pageA.view.webContents.id;
    await invoke('browser-use:hide');
    assert(!window.contentView.children.includes(pageA.view), 'overlay can paint over the browser rectangle');
    assertEqual(manager.state().visible, false, 'hidden state');
    await invoke('browser-use:show', { sessionId: 'A', bounds: { x: 120, y: 110, width: 650, height: 480 } });
    assertEqual(manager.page('A').view.webContents.id, identity, 'same live page');
    assertEqual(await pageA.cdp.evaluate("document.querySelector('#input').value"), 'replaced', 'input state survived');
    assertEqual(pageA.view.getBounds().x, 120, 'new layout applied');
  });

  h.test('task switches reject old scopes and foreign handles while background work keeps its own page', async () => {
    const revision = manager.focusRevision;
    manager.setConversation('B');
    pageB = await manager.createTab('B', `${base}/two`);
    await manager.show({ sessionId: 'B' });
    const foreign = await operations.execute('B', 'eval', { tabId: pageA.handle, expression: 'location.href' });
    assertEqual(object(foreign.error).code, 'refused_by_policy', 'foreign handle refused');
    const old = await invoke('browser-use:show', { sessionId: 'A', focusRevision: revision, targetId: pageA.id });
    assertEqual(old.ok, false, 'old show rejected');
    response(await operations.execute('A', 'navigate', { url: `${base}/background` }));
    assertEqual(manager.state().tabId, pageB.id, 'B remains shown');
    assert(window.contentView.children.includes(pageB.view), 'B remains the native child');
    assertEqual(await pageA.cdp.evaluate('location.pathname'), '/background', 'background A navigated its own page');
  });

  h.test('hiding during an awaited show invalidates its presentation request', async () => {
    const original = pageB.ready;
    let finish!: () => void;
    pageB.ready = new Promise<void>(resolveReady => { finish = resolveReady; });
    const pending = manager.show({ sessionId: 'B', targetId: pageB.id });
    manager.hide(); finish();
    await assertRejects(() => pending, 'hide wins against old show');
    pageB.ready = original;
    assertEqual(manager.state().visible, false, 'old completion does not reattach');
    await manager.show({ sessionId: 'B' });
  });

  h.test('a newly created background page accepts agent input and capture without taking the visible task', async () => {
    const hidden = await manager.createTab('C', `${base}/hidden`);
    window.hide();
    try {
      response(await operations.execute('C', 'click', { selector: '#count' }));
      assertEqual(await hidden.cdp.evaluate("document.querySelector('#result').textContent"), '1', 'background trusted click');
      const image = response(await operations.execute('C', 'screenshot', {}));
      assert(String(object(image.value).dataUrl).startsWith('data:image/jpeg;base64,'), 'background screenshot');
      await hidden.cdp.evaluate("document.body.style.height='1800px'");
      const fullPage = response(await operations.execute('C', 'screenshot', { fullPage: true }));
      const size = nativeImage.createFromDataURL(String(object(fullPage.value).dataUrl)).getSize();
      assert(size.height >= 1800, 'full page screenshot includes content below the viewport');
      assert(hidden.view.webContents.getBackgroundThrottling(), 'background throttling restored after the operation');
      assert(!BaseWindow.getAllWindows().some(entry => entry.isVisible()), 'capture does not show a hidden window');
      assertEqual(manager.conversationId, 'B', 'background work keeps active task');
    } finally {
      window.showInactive();
      manager.releaseConversation('C');
    }
  });

  h.test('navigation history operates on the same task page and reload resets its document', async () => {
    const history = await manager.createTab('history', `${base}/first`);
    try {
      response(await operations.execute('history', 'navigate', { url: `${base}/next` }));
      assertEqual(manager.state('history').canGoBack, true, 'back availability');
      response(await operations.execute('history', 'back', {}));
      assertEqual(history.view.webContents.getURL(), `${base}/first`, 'history back');
      response(await operations.execute('history', 'forward', {}));
      assertEqual(history.view.webContents.getURL(), `${base}/next`, 'history forward');
      response(await operations.execute('history', 'click', { selector: '#count' }));
      response(await operations.execute('history', 'reload', {}));
      assertEqual(await history.cdp.evaluate("document.querySelector('#result').textContent"), '0', 'reload replaces document');
      assertEqual(manager.conversationId, 'B', 'history does not switch active task');
    } finally { manager.releaseConversation('history'); }
  });

  h.test('MCP serves named and facade calls with session-bound loopback capability URLs', async () => {
    const capabilitiesA = await mcp.hostCapabilities('A');
    const capabilitiesB = await mcp.hostCapabilities('B');
    endpointA = String(object((capabilitiesA.mcpServers as Json[])[0]).url);
    endpointB = String(object((capabilitiesB.mcpServers as Json[])[0]).url);
    const initialized = await rpc(endpointA, 'initialize', { protocolVersion: '2025-06-18' });
    assertEqual(initialized.status, 200, 'initialize status'); mcpSession = initialized.sessionId;
    assert(mcpSession, 'MCP session header');
    const headers = { 'Mcp-Session-Id': mcpSession };
    const named = await rpc(endpointA, 'tools/call', { name: 'eval', arguments: { expression: 'location.pathname' } }, headers);
    assertEqual(response(object(named.body.result)).value, '/background', 'named call reaches A');
    const enveloped = await rpc(endpointA, 'tools/call', { name: 'eval', arguments: { operation: { type: 'eval', expression: 'document.title' }, target: { browserId: 'iab', tabId: pageA.handle } } }, headers);
    assertEqual(response(object(enveloped.body.result)).value, '/background', 'facade call reaches A');
    assertEqual((await rpc(endpointB, 'ping', {}, headers)).status, 404, 'MCP session cannot cross capability routes');
    assertEqual((await rpc(endpointA.replace('session=A', 'session=B'), 'ping')).status, 404, 'query cannot forge task ownership');
    assertEqual((await rpc(endpointA, 'ping', {}, { Origin: 'https://untrusted.example' })).status, 403, 'web-origin call rejected');
  });

  h.test('explicit external Chrome failure never opens or changes an IAB page', async () => {
    const before = manager.listPages('A').length;
    const selected = await operations.execute('A', 'select_browser', { browserId: 'chrome:fixture' });
    assertEqual(object(selected.error).code, 'unavailable', 'external route is explicit');
    const followup = await operations.execute('A', 'navigate', { url: `${base}/must-not-open` });
    assertEqual(object(followup.error).code, 'unavailable', 'selection remains external');
    assertEqual(manager.listPages('A').length, before, 'no fallback page');
    assertEqual(pageA.view.webContents.getURL(), `${base}/background`, 'no fallback navigation');
    response(await operations.execute('A', 'select_browser', { browserId: 'iab' }));
  });

  h.test('releasing a task revokes its endpoint and prevents queued operations recreating a tab', async () => {
    const capability = await mcp.hostCapabilities('release');
    const endpoint = String(object((capability.mcpServers as Json[])[0]).url);
    const released = await manager.createTab('release', `${base}/release`);
    const active = operations.execute('release', 'eval', { expression: 'new Promise(resolve=>{globalThis.fixturePending=true;setTimeout(()=>resolve(true),1000)})' });
    await waitFor(async () => await released.cdp.evaluate('globalThis.fixturePending === true') === true, 2000, 'operation started');
    const queued = operations.execute('release', 'new_tab', { url: `${base}/must-not-reopen` });
    mcp.releaseSession('release');
    assertEqual((await queued).isError, true, 'queued operation rejected');
    assertEqual((await active).isError, true, 'active operation cannot use a destroyed page');
    assertEqual(manager.listPages('release').length, 0, 'closed task remains empty');
    assertEqual((await rpc(endpoint, 'ping')).status, 404, 'released token revoked');
  });

  h.test('CDP and navigation policy prevent privileged page/host actions', async () => {
    const refused = await operations.execute('B', 'cdp', { method: 'Target.createTarget', params: { url: 'about:blank' } });
    assertEqual(object(refused.error).code, 'refused_by_policy', 'raw target creation refused');
    const count = manager.listPages('B').length;
    const navigate = await invoke('browser-use:tabs', { action: 'new', url: 'file:///etc/passwd' });
    assertEqual(navigate.ok, false, 'file navigation refused');
    assertEqual(manager.listPages('B').length, count, 'refusal creates no target');
    const permission = await pageB.cdp.evaluate("Notification.requestPermission()");
    assertEqual(permission, 'denied', 'remote permission defaults to denial');
    const settings = await invoke('settings:browser-use:set-enabled', { enabled: false });
    assertEqual(settings.ok, false, 'missing plugin mutation is explicit');
  });

  h.test('OOPIF session evaluation reaches its frame and cannot attach a sibling tab', async () => {
    response(await operations.execute('B', 'navigate', { url: `${base}/iframe` }));
    await waitFor(() => pageB.cdp.frameTargets().length > 0, 8000, 'cross-process iframe attached');
    const frame = pageB.cdp.frameTargets()[0]!;
    const answer = response(await operations.execute('B', 'eval', { expression: 'location.pathname', frameTargetId: frame }));
    assertEqual(answer.value, '/frame', 'frame evaluation');
    const wrong = await operations.execute('B', 'eval', { expression: 'location.pathname', frameTargetId: pageA.cdp.targetId });
    assertEqual(object(wrong.error).code, 'stale_target', 'sibling page cannot become frame session');
  });

  h.test('a synchronous page prompt is answered through its task dialog without exposing host APIs', async () => {
    const paused = operations.execute('B', 'eval', { expression: "prompt('Fixture prompt','default')" });
    await waitFor(() => manager.dialogs.state(pageB) !== null, 2000, 'page prompt opened');
    const pending = object(response(await operations.execute('B', 'dialog', { action: 'get' })).value);
    assertEqual(pending.message, 'Fixture prompt', 'exact prompt text');
    assertEqual(pending.origin, base, 'origin comes from the calling frame');
    assertEqual(pending.sandboxed, true, 'preload runs in the process sandbox');
    const wrong = await operations.execute('A', 'dialog', { action: 'accept', tabId: pageB.handle, promptText: 'wrong task' });
    assertEqual(object(wrong.error).code, 'refused_by_policy', 'another task cannot answer');
    response(await operations.execute('B', 'dialog', { action: 'accept', promptText: 'answered', dialogId: pending.id }));
    assertEqual(response(await paused).value, 'answered', 'sync prompt returns the answer');
    assertDeepEqual(await pageB.cdp.evaluate('({require:typeof require,process:typeof process,module:typeof module,Buffer:typeof Buffer,ipc:typeof ipcRenderer,klaus:typeof window.klaus,host:typeof window.__KLAUS_DESKTOP__})'), { require: 'undefined', process: 'undefined', module: 'undefined', Buffer: 'undefined', ipc: 'undefined', klaus: 'undefined', host: 'undefined' }, 'only the standard page dialog functions are exposed');
  });

  h.test('a human answer from the isolated prompt window resumes the same page', async () => {
    const paused = operations.execute('B', 'eval', { expression: "prompt('Human fixture','default')" });
    await waitFor(() => manager.dialogs.state(pageB) !== null, 2000, 'human prompt opened');
    const promptWindow = (): BrowserWindow | undefined => BrowserWindow.getAllWindows().find(entry => entry.id !== window.id && entry.webContents.getURL().startsWith('data:text/html;charset=utf-8,'));
    await waitFor(() => !!promptWindow()?.isVisible(), 2000, 'restricted prompt window visible');
    const target = promptWindow()!;
    assertEqual(await target.webContents.executeJavaScript('typeof require'), 'undefined', 'prompt has no node integration');
    assertEqual(await target.webContents.executeJavaScript("document.querySelector('#origin').textContent"), base, 'human prompt displays the verified origin');
    writeFileSync(join(__dirname, 'browser-prompt-fixture.png'), (await target.webContents.capturePage()).toPNG());
    await target.webContents.executeJavaScript("document.querySelector('#value').value='human answer';document.querySelector('form').requestSubmit()");
    assertEqual(response(await paused).value, 'human answer', 'human value returns synchronously to original page');
    await waitFor(() => target.isDestroyed(), 2000, 'prompt window cleaned up');
  });

  h.test('OOPIF prompts retain their source frame and cancel without answering a different page', async () => {
    const frame = pageB.cdp.frameTargets()[0]!;
    const paused = operations.execute('B', 'eval', { expression: "prompt('Frame prompt')", frameTargetId: frame });
    await waitFor(() => manager.dialogs.state(pageB) !== null, 2000, 'frame prompt opened');
    assertEqual(manager.dialogs.state(pageB)?.origin, `http://localhost:${port}`, 'cross-origin frame source');
    assertEqual(manager.dialogs.state(pageB)?.sandboxed, true, 'OOPIF preload runs in the process sandbox');
    response(await operations.execute('B', 'dialog', { action: 'dismiss' }));
    assertEqual(response(await paused).value, null, 'cancel returns null');
    assertDeepEqual(await pageB.cdp.evaluate('({require:typeof require,process:typeof process,module:typeof module,Buffer:typeof Buffer,ipc:typeof ipcRenderer,klaus:typeof window.klaus,host:typeof window.__KLAUS_DESKTOP__})', frame), { require: 'undefined', process: 'undefined', module: 'undefined', Buffer: 'undefined', ipc: 'undefined', klaus: 'undefined', host: 'undefined' }, 'sandboxed OOPIF exposes neither Node nor host APIs');
  });

  h.test('same-origin iframe prompt uses its own frame bridge while its main world remains unprivileged', async () => {
    const globals = await pageB.cdp.evaluate("(()=>{const f=window.frames[1];return {require:typeof f.require,process:typeof f.process,module:typeof f.module,Buffer:typeof f.Buffer,ipc:typeof f.ipcRenderer,klaus:typeof f.klaus,host:typeof f.__KLAUS_DESKTOP__}})()");
    assertDeepEqual(globals, { require: 'undefined', process: 'undefined', module: 'undefined', Buffer: 'undefined', ipc: 'undefined', klaus: 'undefined', host: 'undefined' }, 'same-origin iframe has no host symbols');
    const paused = operations.execute('B', 'eval', { expression: "window.frames[1].prompt('Same-origin prompt')" });
    await waitFor(() => manager.dialogs.state(pageB) !== null, 2000, 'same-origin frame prompt opened');
    assertEqual(manager.dialogs.state(pageB)?.url, `${base}/same-frame`, 'request belongs to the child frame');
    assertEqual(manager.dialogs.state(pageB)?.sandboxed, true, 'same-origin frame preload is sandboxed');
    response(await operations.execute('B', 'dialog', { action: 'accept', promptText: 'frame answer' }));
    assertEqual(response(await paused).value, 'frame answer', 'frame resumes with its answer');
  });

  h.test('navigation cancels a pending dialog and an old answer cannot complete a new dialog', async () => {
    const paused = operations.execute('B', 'eval', { expression: "prompt('Old document')" });
    await waitFor(() => manager.dialogs.state(pageB) !== null, 2000, 'old document prompt opened');
    const oldId = manager.dialogs.state(pageB)?.id;
    await manager.navigate(pageB, `${base}/after-dialog`);
    await paused;
    assertEqual(manager.dialogs.state(pageB), null, 'navigation canceled prompt');
    const current = operations.execute('B', 'eval', { expression: "prompt('New document')" });
    await waitFor(() => manager.dialogs.state(pageB) !== null, 2000, 'new document prompt opened');
    const stale = await operations.execute('B', 'dialog', { action: 'accept', dialogId: oldId, promptText: 'old answer' });
    assertEqual(object(stale.error).code, 'stale_dialog', 'stale answer refused');
    response(await operations.execute('B', 'dialog', { action: 'dismiss' }));
    assertEqual(response(await current).value, null, 'new prompt canceled explicitly');
  });

  h.test('background prompts time out without raising a window and page close cancels pending requests', async () => {
    const hidden = await manager.createTab('prompt-background', `${base}/prompt-background`);
    const count = BrowserWindow.getAllWindows().length;
    const timed = operations.execute('prompt-background', 'eval', { expression: "confirm('Background confirmation')" });
    await waitFor(() => manager.dialogs.state(hidden) !== null, 2000, 'background confirm pending');
    assertEqual(BrowserWindow.getAllWindows().length, count, 'no background prompt window');
    assertEqual(response(await timed).value, false, 'timeout cancels synchronous confirmation');
    const closing = operations.execute('prompt-background', 'eval', { expression: "prompt('Will close')" });
    await waitFor(() => manager.dialogs.state(hidden) !== null, 2000, 'closing prompt pending');
    manager.releaseConversation('prompt-background');
    assertEqual((await closing).isError, true, 'closed page cannot return a live tool result');
    assertEqual(manager.listPages('prompt-background').length, 0, 'task stays closed');
  });

  h.test('window.open creates a same-task native tab with the same private profile', async () => {
    response(await operations.execute('B', 'click', { selector: '#popup' }));
    assertEqual(await pageB.cdp.evaluate('window.popupClicked === true'), true, 'page received the popup click');
    await waitFor(() => manager.listPages('B').length === 2, 5000, 'popup tab appeared');
    const popup = manager.page('B');
    await popup.ready;
    await waitFor(() => popup.view.webContents.getURL().endsWith('/popup'), 5000, 'popup navigated');
    assertEqual(popup.view.webContents.session, manager.browserSession, 'popup uses IAB profile');
    assertEqual(await popup.cdp.evaluate('typeof require'), 'undefined', 'popup has no node');
    assert(manager.listPages('A').every(page => page.handle !== popup.handle), 'popup belongs only to B');
    manager.closeTab('B', popup.handle);
  });

  h.test('tab get and selected return one stable row while Chrome-only naming fails explicitly', async () => {
    const selected = response(await operations.execute('B', 'tabs', { action: 'selected' }));
    assertEqual(object(selected.value).tabId, pageB.handle, 'selected returns the active tab instead of the whole list');
    const got = response(await operations.execute('B', 'tabs', { action: 'get', tabId: pageB.handle }));
    assertEqual(object(got.value).tabId, pageB.handle, 'get returns the requested tab instead of the whole list');
    const named = await operations.execute('B', 'tabs', { action: 'name_session', name: 'Fixture' });
    assertEqual(object(named.error).code, 'unavailable', 'built-in tab-group naming names the Chrome-only boundary');
  });

  h.test('download returns a completed file and clearing cookies leaves the app session alone', async () => {
    const downloaded = response(await operations.execute('B', 'download', { url: `${base}/download`, timeoutMs: 5000 }));
    const path = String(object(downloaded.value).path);
    assert(path.startsWith(manager.downloadDirectory), 'download path is managed by Klaus');
    assertEqual(readFileSync(path, 'utf8'), 'browser fixture download', 'actual completed bytes');
    assert((await manager.browserSession.cookies.get({ url: base })).some(cookie => cookie.name === 'browser_fixture'), 'IAB login cookie exists');
    await session.defaultSession.cookies.set({ url: base, name: 'app_only', value: 'preserve' });
    await manager.clearData('cookies');
    assertEqual((await manager.browserSession.cookies.get({ url: base })).length, 0, 'IAB cookie cleared');
    assert((await session.defaultSession.cookies.get({ url: base })).some(cookie => cookie.name === 'app_only'), 'app cookie retained');
  });

  h.test('closing background, active and last tabs keeps identity and creates no replacement', async () => {
    manager.setConversation('A');
    const second = await manager.createTab('A', `${base}/second`);
    const third = await manager.createTab('A', `${base}/third`);
    manager.selectTab('A', second.handle);
    await manager.show({ sessionId: 'A' });
    manager.closeTab('A', pageA.handle);
    assertEqual(manager.state().tabId, second.id, 'closing background tab preserves active');
    manager.closeTab('A', second.handle);
    assertEqual(manager.state().tabId, third.id, 'right neighbour selected');
    manager.closeTab('A', third.handle);
    assertEqual(manager.state().tabs.length, 0, 'last tab stays closed');
    assertEqual(manager.state().visible, false, 'empty panel detached');
    const oldHandle = third.handle;
    const replacement = await manager.createTab('A', `${base}/fresh`);
    assert(replacement.handle > oldHandle, 'closed handles are never reused');
    enabled = false; manager.hide();
    assertEqual((await invoke('browser-use:show')).ok, false, 'disabled plugin cannot show a page');
    enabled = true;
  });

  h.test('a page that destroys itself cannot poison later tab operations', async () => {
    manager.setConversation('A');
    const before = manager.listPages('A').length;
    const doomed = await manager.createTab('A', `${base}/doomed`);
    await manager.show({ sessionId: 'A' });
    // A page-initiated close (window.close(), an OAuth popup tearing itself
    // down) destroys the WebContents behind the manager's back. Electron then
    // answers undefined for view.webContents, which used to abort forget()
    // before it dropped the page from the map, so every later state or close
    // call died reading isDestroyed off undefined.
    doomed.view.webContents.close({ waitForBeforeUnload: false });
    await waitFor(() => !manager.listPages('A').some(page => page.handle === doomed.handle), 5000, 'self-closed page leaves the conversation');
    assert(manager.state('A').tabs.every(tab => tab.id !== doomed.id), 'state stays readable and drops the destroyed page');
    const dead = await assertRejects(async () => manager.page('A', doomed.handle), 'the dead handle is reported stale by page lookups');
    assertEqual(object(dead).code, 'stale_tab', 'reading a self-closed page answers stale_tab');
    manager.closeTab('A', doomed.handle);
    assertEqual(manager.listPages('A').length, before, 'closing an already-destroyed page is idempotent');
    const fresh = await manager.createTab('A', `${base}/fresh`);
    manager.closeTab('A', fresh.handle);
    assertEqual(manager.state('A').tabs.length, before, 'later closes still succeed');
  });

  h.test('native download ids isolate simultaneous same-URL tasks and expire with their page',async()=>{
    const firstPage=await manager.createTab('download-A',`${base}/one`);const secondPage=await manager.createTab('download-B',`${base}/two`);
    const [first,second]=await Promise.all([manager.download(firstPage,{url:`${base}/download`},5000),manager.download(secondPage,{url:`${base}/download`},5000)]);
    assert(first.id!==second.id&&first.path!==second.path,'distinct task-owned records and files');
    await assertRejects(()=>manager.download(secondPage,{waitOnly:true,downloadId:first.id!},100),'foreign download id refused');
    assertEqual(readFileSync(String(first.path),'utf8'),'browser fixture download','first task file completed');
    manager.closeTab('download-A',firstPage.handle);
    await assertRejects(async()=>manager.download(firstPage,{waitOnly:true,downloadId:first.id!},100),'closed page download id refused');
    assertEqual((await manager.download(secondPage,{waitOnly:true,downloadId:second.id!},100)).path,second.path,'other task remains usable');
    manager.releaseConversation('download-B');
  });

  registerAdvancedBrowserTests(h, { call: (kind, fields) => operations.execute('advanced', kind, fields), base: () => base, directory: profile!, nativeDownloads:true });

  h.test('named IAB permissions preserve task and origin boundaries', async () => {
    const permitted = response(await operations.execute('advanced', 'permission', { action: 'grant', origin: base, permissions: ['geolocation'] }));
    assertEqual(object(permitted.value).scope, 'task', 'grant is task-scoped');
    const query = 'navigator.permissions.query({name:"geolocation"}).then(p=>p.state)';
    assertEqual(response(await operations.execute('advanced', 'eval', { expression: query })).value, 'granted', 'known IAB page sees its grant');
    assertEqual(response(await operations.execute('B', 'eval', { expression: query })).value, 'denied', 'other task did not inherit the grant');
    response(await operations.execute('advanced', 'permission', { action: 'set', origin: base, permission: 'geolocation', setting: 'denied' }));
    assertEqual(response(await operations.execute('advanced', 'eval', { expression: query })).value, 'denied', 'named denial takes effect');
    response(await operations.execute('advanced', 'permission', { action: 'reset' }));
    assertEqual((await operations.execute('advanced', 'permission', { action: 'grant', origin: 'file:///tmp', permissions: ['geolocation'] })).isError, true, 'non-web origin refused');
  });

  h.test('run_preview creates a real hidden page and only a manual action reveals it', async () => {
    assertEqual((await invoke('browser-use:set-conversation', { conversationId: 'preview' })).ok, true, 'preview conversation selected');
    const scope = { sessionId: 'preview', toolCallId: 'preview-call', focusRevision: manager.focusRevision };
    const before = pushes.filter(push => push.channel === 'browser-use:open-panel').length;
    const result = await preview.start({ url: `${base}/preview`, name: 'Fixture preview' }, 'preview', 'preview-call', () => {});
    assertEqual(object(result).success, true, 'tool navigated successfully');
    const page = manager.listPages('preview')[0]!;
    assert(page, 'preview page exists');
    assertEqual(page.view.webContents.getURL(), `${base}/preview`, 'preview URL loaded in a real WebContentsView');
    assertEqual(manager.state('preview').visible, false, 'background tool did not reveal the panel');
    assertEqual(pushes.filter(push => push.channel === 'browser-use:open-panel').length, before, 'no panel request sent');
    assertEqual(object(await invoke('run-preview:state', scope)).tabId, page.id, 'host owns the call and tab');
    const foreign = await invoke('run-preview:open', { ...scope, sessionId: 'A', url: `${base}/preview`, name: 'Foreign' });
    assertEqual(foreign.ok, false, 'foreign chat cannot reopen the page');
    const refused = await invoke('run-preview:open', { ...scope, url: 'file:///tmp/private', name: 'File' });
    assertEqual(refused.ok, false, 'privileged URL cannot be opened');
    assertEqual(manager.listPages('preview').length, 1, 'rejected URLs did not create pages');
    const manual = await invoke('run-preview:open', { ...scope, url: `${base}/preview`, name: 'Fixture preview' });
    assertEqual(manual.tabId, page.id, 'manual open reuses the existing page');
    assertEqual((await invoke('browser-use:show', { sessionId: 'preview', focusRevision: manager.focusRevision, targetId: page.id, bounds: { x: 0, y: 0, width: 700, height: 500 } })).ok, true, 'manual click reveals the page');
    assertEqual(manager.state('preview').visible, true, 'page visible only after manual action');
  });

  h.test('shutdown closes all page webContents and revokes the MCP endpoint', async () => {
    const ids = [...manager.listPages('A'), ...manager.listPages('B')].map(page => page.view.webContents.id);
    await mcp.shutdown();
    manager.dispose();
    await waitFor(() => ids.every(id => !webContents.fromId(id)), 5000, 'all child webContents destroyed');
    assertDeepEqual(BaseWindow.getAllWindows().map(entry => entry.id), [window.id], 'hidden native container was closed');
    await assertRejects(() => rpc(endpointA, 'ping'), 'MCP listener stopped');
    assert(!pushes.some(push => push.channel === 'browser-use:frame'), 'no human JPEG stream was emitted');
  });

  try { return await h.finish(join(__dirname, 'browser-electron-result.json'), 'browser-electron'); }
  finally {
    await mcp.shutdown(); manager.dispose();
    if (!window.isDestroyed()) window.destroy();
    fixture.closeAllConnections();
    await new Promise<void>(resolveClose => fixture.close(() => resolveClose()));
  }
}

void main().then(code => app.exit(code)).catch(error => { process.stderr.write(`${String(error)}\n`); app.exit(1); });
