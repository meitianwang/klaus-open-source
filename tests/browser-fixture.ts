import { app, BaseWindow, BrowserWindow, nativeImage, session } from 'electron';
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
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
app.commandLine.appendSwitch('native-browser-enabled');
app.commandLine.appendSwitch('native-browser-data-dir', join(profile, 'electron', 'native-browser'));
app.commandLine.appendSwitch('site-per-process');
app.on('window-all-closed', () => {});

async function main(): Promise<number> {
  await app.whenReady();
  const h = new Harness();
  const receivedRequests: Array<{ path: string; method: string; body: string }> = [];
  let deniedTargetRequests = 0;
  let canceledTargetRequests = 0;
  const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  };
  const fixture = createServer((request, response) => {
    void (async () => {
    if (serveAdvancedFixture(request, response, `http://127.0.0.1:${port}`)) return;
    const pathname = new URL(request.url ?? '/', 'http://fixture').pathname;
    if (pathname === '/post-source') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; form-action 'self' http://localhost:*" });
      response.end(`<!doctype html><title>Post source</title>
        <form id="post-plain" method="post" action="http://localhost:${port}/post-target"><input name="payload" value="plain-body"><button id="send-plain">Send plain</button></form>
        <form id="post-302" method="post" action="http://localhost:${port}/redirect-302"><input name="payload" value="redirect-302-body"><button id="send-302">Send 302</button></form>
        <form id="post-307" method="post" action="http://localhost:${port}/redirect-307"><input name="payload" value="redirect-307-body"><button id="send-307">Send 307</button></form>`);
      return;
    }
    if (pathname === '/slow-source') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>Slow source</title><a id="slow" href="/slow-download">Slow download</a>');
      return;
    }
    if (pathname === '/post-target' || pathname === '/method-target' || pathname === '/redirect-302' || pathname === '/redirect-307') {
      const body = await readBody(request);
      receivedRequests.push({ path: `${pathname}${new URL(request.url ?? '/', 'http://fixture').search}`, method: request.method ?? 'GET', body });
      if (pathname === '/redirect-302') { response.writeHead(302, { Location: `http://localhost:${port}/method-target?case=302` }); response.end(); return; }
      if (pathname === '/redirect-307') { response.writeHead(307, { Location: `http://localhost:${port}/method-target?case=307` }); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<!doctype html><title>${pathname}</title><p>${request.method}</p>`);
      return;
    }
    if (pathname === '/deny-target') { deniedTargetRequests += 1; response.writeHead(200); response.end('unexpected'); return; }
    if (pathname === '/cancel-target') { canceledTargetRequests += 1; response.writeHead(200); response.end('unexpected'); return; }
    if (pathname === '/slow-download') {
      const chunk = Buffer.alloc(64 * 1024, 7);
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(chunk.length * 20),
        'Content-Disposition': 'attachment; filename="slow.bin"',
      });
      let sent = 0;
      const timer = setInterval(() => {
        if (response.destroyed || sent >= 20) { clearInterval(timer); if (!response.destroyed) response.end(); return; }
        response.write(chunk); sent += 1;
      }, 80);
      response.once('close', () => clearInterval(timer));
      return;
    }
    if (pathname === '/download') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="fixture.txt"' }); response.end('browser fixture download'); return;
    }
    if (pathname === '/cross-redirect') {
      response.writeHead(302, { Location: `http://localhost:${port}/redirect-target` }); response.end(); return;
    }
    if (pathname === '/page.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end("document.querySelector('#count').onclick=()=>{document.querySelector('#result').textContent=String(Number(document.querySelector('#result').textContent)+1)};document.querySelector('#popup').onclick=()=>{window.popupClicked=true;window.popupOpened=!!window.open('/popup')};console.log('fixture loaded');"); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self' http://localhost:*;", 'Set-Cookie': 'browser_fixture=present; Path=/; SameSite=Lax' });
    response.end(`<!doctype html><title>${request.url}</title><style>body{margin:20px;background:#e4f0fb}input,button{font:20px sans-serif;margin:8px;padding:8px}iframe{width:300px;height:100px}</style><h1>${request.url}</h1><input id="input" aria-label="Fixture input"><button id="count">Increment</button><span id="result">0</span><button id="popup">Open popup</button><script src="/page.js"></script>${request.url === '/iframe' ? `<iframe src="http://localhost:${port}/frame"></iframe><iframe src="/same-frame"></iframe>` : ''}`);
    })().catch(error => { if (!response.headersSent) response.writeHead(500); if (!response.writableEnded) response.end(String(error)); });
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
  const permissionRequests: string[] = [];
  const authorizationRequests: Array<{ sessionId: string; url: string; resource: string }> = [];
  const sitePermissions = new Map<string, 'granted' | 'denied'>();
  const openedDownloads: string[] = [];
  const revealedDownloads: string[] = [];
  let manager!: BrowserManager;
  manager = new BrowserManager({
    window, configRoot: profile!, enabled: () => enabled, dialogTimeoutMs: 3000,
    requestPermission: async request => { permissionRequests.push(request.permission); return false; },
    sitePermission: (origin, permission) => sitePermissions.get(`${origin}\u0000${permission}`),
    downloadDirectory: () => join(profile!, 'browser-downloads'),
    promptForUserDownloads: () => false,
    openDownloadPath: async path => { openedDownloads.push(path); return ''; },
    revealDownloadPath: path => { revealedDownloads.push(path); },
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

  h.test('UI creates an actual sandboxed native page and receives the current tab contract', async () => {
    assertEqual((await invoke('browser-use:set-conversation', { conversationId: 'A' })).ok, true, 'set conversation');
    const created = await invoke('browser-use:tabs', { action: 'new', url: `${base}/one` });
    assertEqual(created.ok, true, `create tab: ${JSON.stringify(created)}`);
    pageA = manager.page('A');
    assertEqual(object(created.state).tabId, pageA.id, 'UI opaque id');
    assertEqual(object((created.tabs as Json[])[0]).id, pageA.id, 'tab rows use id');
    const shown = await invoke('browser-use:show', { sessionId: 'A', focusRevision: manager.focusRevision, bounds: { x: 100, y: 100, width: 700, height: 500 } });
    assertEqual(shown.ok, true, 'show');
    assertEqual(manager.state('A').visible, true, 'native page is presented');
    assertDeepEqual(pageA.native.getBounds(), { x: 100, y: 100, width: 700, height: 500 }, 'view bounds');
    const globals = await pageA.cdp.evaluate('({require:typeof require,process:typeof process,klaus:typeof window.klaus,host:typeof window.__KLAUS_DESKTOP__})');
    assertDeepEqual(globals, { require: 'undefined', process: 'undefined', klaus: 'undefined', host: 'undefined' }, 'remote page has no host bridge');
  });

  h.test('screen wake locks can be reacquired without a permission dialog', async () => {
    await waitFor(async () => {
      app.focus({ steal: true }); window.focus(); pageA.native.focus();
      return await pageA.cdp.evaluate('document.visibilityState') === 'visible';
    }, 3000, 'the requesting page is visible');
    const promptCount = permissionRequests.length;
    const query = 'navigator.permissions.query({name:"screen-wake-lock"}).then(p=>p.state)';
    assertEqual(await pageA.cdp.evaluate(query), 'granted', 'the permission check uses the silent default');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assertEqual(await pageA.cdp.evaluate('(async()=>{const lock=await navigator.wakeLock.request("screen");const acquired=!lock.released;await lock.release();return acquired&&lock.released})()'), true, 'the real page acquires and releases its wake lock');
    }
    assertEqual(permissionRequests.length, promptCount, 'repeated wake locks never ask the user');
    await manager.setPermission(pageA, { action: 'set', origin: base, permission: 'screen-wake-lock', setting: 'denied' });
    assertEqual(await pageA.cdp.evaluate(query), 'denied', 'an explicit site denial overrides the default');
    assertEqual(await pageA.cdp.evaluate('navigator.wakeLock.request("screen").then(()=>false,error=>error.name==="NotAllowedError")'), true, 'the real request respects an explicit denial');
    assertEqual(permissionRequests.length, promptCount, 'an explicit denial stays silent');
    await manager.setPermission(pageA, { action: 'reset' });
    assertEqual(await pageA.cdp.evaluate(query), 'granted', 'reset restores the silent default');
    assertEqual(await pageA.cdp.evaluate('Notification.requestPermission()'), 'denied', 'notifications still require a decision');
    assertDeepEqual(permissionRequests.slice(promptCount), ['notifications'], 'only the notification requested confirmation');
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
    pageA.native.focus();
    await pageA.cdp.evaluate("document.querySelector('#input').focus()");
    await waitFor(async () => await pageA.cdp.evaluate('document.hasFocus()') === true, 2000, 'native page has focus');
    await waitFor(async () => {
      if (await pageA.cdp.evaluate("document.querySelector('#input').value") === 'h') return true;
      // Other GUI fixtures may become key while this async test is awaiting.
      // sendInputEvent requires a focused owning window; reacquire before typing.
      app.focus({ steal: true }); window.focus(); pageA.native.focus();
      await pageA.cdp.evaluate("document.querySelector('#input').focus()");
      if (!window.isFocused()) return false;
      await pageA.cdp.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'h', code: 'KeyH', windowsVirtualKeyCode: 72, text: 'h', unmodifiedText: 'h' });
      await pageA.cdp.command('Input.dispatchKeyEvent', { type: 'char', key: 'h', code: 'KeyH', text: 'h', unmodifiedText: 'h' });
      await pageA.cdp.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'h', code: 'KeyH', windowsVirtualKeyCode: 72 });
      return await pageA.cdp.evaluate("document.querySelector('#input').value") === 'h';
    }, 3000, 'native input reached page');
    response(await operations.execute('A', 'type', { selector: '#input', text: '人工' }));
    const answer = response(await operations.execute('A', 'eval', { expression: "document.querySelector('#input').value" }));
    assertEqual(answer.value, 'h人工', 'agent reads native focus and CDP input on the same page');
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

  h.test('stopping real browser typing releases the key and prevents later characters or Enter', async () => {
    const controller = new AbortController();
    const previousValue = await pageA.cdp.evaluate("document.querySelector('#input').value");
    await pageA.cdp.evaluate(`(()=>{
      const input=document.querySelector('#input');input.value='';
      window.__inputCancellation={keys:[],listener:new AbortController()};
      const options={signal:window.__inputCancellation.listener.signal};
      input.addEventListener('keydown',event=>window.__inputCancellation.keys.push('down:'+event.key),options);
      input.addEventListener('keyup',event=>window.__inputCancellation.keys.push('up:'+event.key),options);
      input.addEventListener('input',()=>console.log('fixture-input-cancellation'),options);
    })()`);
    const stop = pageA.cdp.onEvent((method, params) => {
      if (method === 'Runtime.consoleAPICalled' && object((params.args as Json[] | undefined)?.[0]).value === 'fixture-input-cancellation') controller.abort();
    });
    try {
      const answer = await operations.execute('A', 'type', { selector: '#input', text: 'abc', delayMs: 200, pressEnter: true }, controller.signal);
      assertEqual(object(answer.error).code, 'cancelled', 'the task reports cancellation');
      await waitFor(async () => Boolean(await pageA.cdp.evaluate("window.__inputCancellation.keys.includes('up:a')")), 3000, 'the real page receives key release');
      const observed = object(await pageA.cdp.evaluate("({value:document.querySelector('#input').value,keys:window.__inputCancellation.keys})"));
      assertEqual(observed.value, 'a', 'typing stops after the first delivered character');
      assertDeepEqual(observed.keys, ['down:a', 'up:a'], 'no later character or Enter reaches the actual page');
    } finally {
      stop();
      await pageA.cdp.evaluate(`window.__inputCancellation.listener.abort();delete window.__inputCancellation;document.querySelector('#input').value=${JSON.stringify(previousValue)}`);
    }
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
    const identity = pageA.handle;
    const nativeIdentity = pageA.native;
    await invoke('browser-use:hide');
    assertEqual(manager.state().visible, false, 'overlay can paint over the browser rectangle');
    await invoke('browser-use:show', { sessionId: 'A', bounds: { x: 120, y: 110, width: 650, height: 480 } });
    assertEqual(manager.page('A').handle, identity, 'same live page');
    assert(manager.page('A').native === nativeIdentity, 'same native handle');
    assertEqual(manager.state().visible, true, 'native page restored');
    assertEqual(await pageA.cdp.evaluate("document.querySelector('#input').value"), 'replaced', 'input state survived');
    assertEqual(pageA.native.getBounds().x, 120, 'new layout applied');
  });

  h.test('a modal overlay gets a still of the shown page, creates no page and takes keyboard focus back', async () => {
    const before = manager.listPages('A').map(page => page.id);
    const still = await invoke('browser-use:screenshot', { presented: true, quality: 70 });
    assertEqual(still.ok, true, `presented capture: ${JSON.stringify(still).slice(0, 200)}`);
    assertEqual(still.tabId, pageA.id, 'the capture names the page on screen');
    const size = nativeImage.createFromDataURL(String(still.dataUrl)).getSize();
    assert(size.width > 0 && size.height > 0, 'the still decodes to a real image');
    app.focus({ steal: true }); window.focus(); pageA.view.webContents.focus();
    await waitFor(() => pageA.view.webContents.isFocused(), 3000, 'the page holds keyboard focus');
    await invoke('browser-use:hide');
    await waitFor(() => window.webContents.isFocused(), 3000, 'the window page takes focus back for its dialog');
    assert(!pageA.view.webContents.isFocused(), 'the detached page no longer receives keys');
    const hidden = await invoke('browser-use:screenshot', { presented: true });
    assertEqual(hidden.ok, false, 'nothing on screen means nothing to capture');
    assertEqual(hidden.code, 'not_found', 'a precise refusal');
    manager.setConversation('empty-task');
    const empty = await invoke('browser-use:screenshot', { presented: true });
    assertEqual(empty.ok, false, 'an empty task is refused too');
    assertDeepEqual(manager.listPages('empty-task'), [], 'the capture never creates a blank page');
    manager.setConversation('A');
    assertDeepEqual(manager.listPages('A').map(page => page.id), before, 'the task keeps exactly its pages');
    await invoke('browser-use:show', { sessionId: 'A', focusRevision: manager.focusRevision, bounds: { x: 120, y: 110, width: 650, height: 480 } });
    assert(window.contentView.children.includes(pageA.view), 'the page returns after the overlay');
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
    assertEqual(manager.state('B').visible, true, 'B remains the presented native page');
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
      assertEqual(hidden.native.isDestroyed(), false, 'background page remains live after capture');
      assertEqual(await hidden.cdp.evaluate("document.querySelector('#count') !== null"), true, 'background page remains readable after capture');
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
      assertEqual(history.native.getURL(), `${base}/first`, 'history back');
      response(await operations.execute('history', 'forward', {}));
      assertEqual(history.native.getURL(), `${base}/next`, 'history forward');
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
    assertEqual(pageA.native.getURL(), `${base}/background`, 'no fallback navigation');
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
    assertEqual(new URL(String(pending.url)).origin, base, 'origin comes from the calling page URL');
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
    const frameDialog = manager.dialogs.state(pageB);
    assert(frameDialog, 'frame dialog state exists');
    assertEqual(new URL(frameDialog.url).origin, `http://localhost:${port}`, 'cross-origin frame source');
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
    await waitFor(() => popup.native.getURL().endsWith('/popup'), 5000, 'popup navigated');
    await waitFor(async () => String(await popup.cdp.evaluate('document.cookie')).includes('browser_fixture=present'), 3000, 'popup shares the native profile cookie jar');
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
    assert(String(await pageB.cdp.evaluate('document.cookie')).includes('browser_fixture=present'), 'native profile login cookie exists');
    await session.defaultSession.cookies.set({ url: base, name: 'app_only', value: 'preserve' });
    assert(!String(await pageB.cdp.evaluate('document.cookie')).includes('app_only'), 'native profile does not see the Electron app session cookie');
    await manager.clearData('cookies');
    await waitFor(async () => !String(await pageB.cdp.evaluate('document.cookie')).includes('browser_fixture'), 3000, 'native profile cookie cleared');
    assert((await session.defaultSession.cookies.get({ url: base })).some(cookie => cookie.name === 'app_only'), 'app cookie retained');
  });

  h.test('download history uses the product shape and removing a row keeps the file', async () => {
    const filename = `history-${Date.now()}.txt`;
    const downloaded = response(await operations.execute('B', 'download', { url: `${base}/download`, filename, timeoutMs: 5000 }));
    const path = String(object(downloaded.value).path);
    let row: BrowserObject | undefined;
    await waitFor(() => {
      const page = manager.downloadHistory({ query: filename }) as { items?: BrowserObject[] };
      row = page.items?.find(item => item.filename === filename);
      return !!row;
    }, 5000, 'download metadata appears');
    assertEqual(row?.state, 'completed', 'completed state');
    assertEqual(row?.receivedBytes, 24, 'actual byte count');
    assertEqual(row?.exists, true, 'existing file');
    assertDeepEqual(await manager.downloadAction('remove', String(row?.id)), { ok: true }, 'remove terminal history row');
    assertEqual(existsSync(path), true, 'removing history never deletes the file');
  });

  h.test('browsing history distinguishes manual and agent visits and supports removal', async () => {
    const session = 'history-shape';
    const manualUrl = `${base}/history-manual`;
    const agentUrl = `${base}/history-agent`;
    const page = await manager.createTab(session, manualUrl);
    await waitFor(() => (manager.history({ query: 'history-manual' }) as { items?: BrowserObject[] }).items?.length === 1, 5000, 'manual visit recorded');
    const manual = (manager.history({ query: 'history-manual' }) as { items: BrowserObject[] }).items[0]!;
    assertEqual(manual.isActorVisit, false, 'direct page open is not agent attributed');
    assertEqual(typeof manual.visitTime, 'number', 'visit time is epoch milliseconds');

    const finish = manager.beginOperation(session, 'navigate');
    try { await manager.navigate(page, agentUrl); } finally { finish(); }
    await waitFor(() => (manager.history({ query: 'history-agent' }) as { items?: BrowserObject[] }).items?.length === 1, 5000, 'agent visit recorded');
    const agent = (manager.history({ query: 'history-agent' }) as { items: BrowserObject[] }).items[0]!;
    assertEqual(agent.isActorVisit, true, 'agent navigation retains attribution');
    assertDeepEqual(manager.historyRemove([String(manual.id)]), { ok: true }, 'history removal receipt');
    assertEqual((manager.history({ query: 'history-manual' }) as { items?: BrowserObject[] }).items?.length, 0, 'removed visit is gone');
    manager.releaseConversation(session);
  });

  h.test('persistent site permissions override task memory until the policy changes', async () => {
    const session = 'site-policy';
    const page = await manager.createTab(session, `${base}/site-policy`);
    const origin = new URL(base).origin;
    const key = `${origin}\u0000screen-wake-lock`;
    sitePermissions.set(key, 'denied');
    assertEqual(await page.cdp.evaluate('navigator.permissions.query({name:"screen-wake-lock"}).then(p=>p.state)'), 'denied', 'persistent site denial');
    sitePermissions.delete(key);
    manager.refreshPermissions();
    assertEqual(await page.cdp.evaluate('navigator.permissions.query({name:"screen-wake-lock"}).then(p=>p.state)'), 'granted', 'policy refresh takes effect without a restart');
    manager.releaseConversation(session);
  });

  h.test('agent cross-origin redirects and popups pause for authorization', async () => {
    const session = 'agent-gate';
    const page = await manager.createTab(session, `${base}/gate-start`);
    const options = (manager as unknown as { options: { authorize?: (sessionId: string, url: string, resource: string) => Promise<void> | void } }).options;
    const previous = options.authorize;
    options.authorize = async (sessionId, url, resource) => {
      authorizationRequests.push({ sessionId, url, resource });
      await new Promise(resolveWait => setTimeout(resolveWait, 30));
    };
    try {
      await manager.authorize(session, `${base}/cross-redirect`, 'browsing');
      const finish = manager.beginOperation(session, 'navigate');
      const navigation = manager.navigate(page, `${base}/cross-redirect`, { timeoutMs: 5000 }).catch(() => {});
      try {
        await waitFor(() => page.native.getURL() === `http://localhost:${port}/redirect-target`, 10_000, 'cross-origin redirect committed');
      } finally { finish(); }
      await navigation;
      assert(authorizationRequests.some(row => row.url === `http://localhost:${port}/redirect-target` && row.resource === 'browsing'), 'redirect destination was authorized');

      const before = manager.listPages(session).length;
      const popupUrl = `http://localhost:${port}/popup-target`;
      response(await operations.execute(session, 'eval', { expression: `(()=>{window.open(${JSON.stringify(popupUrl)},'_blank');return true})()` }));
      await waitFor(() => manager.listPages(session).length === before + 1, 5000, 'authorized popup opened');
      const popup = manager.page(session);
      await waitFor(() => popup.native.getURL() === popupUrl, 5000, 'popup reached its authorized destination');
      assert(authorizationRequests.some(row => row.url === popupUrl && row.resource === 'browsing'), 'popup destination was authorized');
    } finally {
      options.authorize = previous;
      manager.releaseConversation(session);
    }
  });

  h.test('main-frame authorization preserves POST bodies and 302/307 semantics', async () => {
    const session = 'post-gate';
    const page = await manager.createTab(session, `${base}/post-source`);
    const options = (manager as unknown as { options: { authorize?: (sessionId: string, url: string, resource: string, signal?: AbortSignal) => Promise<void> | void } }).options;
    const previous = options.authorize;
    options.authorize = async (_sessionId, _url, _resource, signal) => {
      if (signal?.aborted) throw new Error('aborted');
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    };
    const submit = async (form: string, expected: string): Promise<void> => {
      const start = receivedRequests.length;
      const finish = manager.beginOperation(session, 'click');
      try {
        await page.cdp.evaluate(`document.querySelector('#${form}').requestSubmit(); true`);
        await waitFor(() => receivedRequests.slice(start).some(row => row.path.startsWith(expected)), 5000, `${form} reached ${expected}`);
      } finally { finish(); }
    };
    try {
      await submit('post-plain', '/post-target');
      const plain = receivedRequests.find(row => row.path === '/post-target' && row.body.includes('plain-body'));
      assertEqual(plain?.method, 'POST', 'cross-origin POST method retained');
      assertEqual(plain?.body, 'payload=plain-body', 'cross-origin POST body retained');

      await manager.navigate(page, `${base}/post-source`);
      await submit('post-302', '/redirect-302');
      await waitFor(() => receivedRequests.some(row => row.path === '/method-target?case=302'), 5000, '302 target reached');
      const from302 = receivedRequests.find(row => row.path === '/method-target?case=302');
      assertEqual(from302?.method, 'GET', '302 follows the standard POST-to-GET transition');
      assertEqual(from302?.body, '', '302 does not invent a body');

      await manager.navigate(page, `${base}/post-source`);
      await submit('post-307', '/redirect-307');
      await waitFor(() => receivedRequests.some(row => row.path === '/method-target?case=307'), 5000, '307 target reached');
      const from307 = receivedRequests.find(row => row.path === '/method-target?case=307');
      assertEqual(from307?.method, 'POST', '307 retains POST');
      assertEqual(from307?.body, 'payload=redirect-307-body', '307 retains the original body');
    } finally {
      options.authorize = previous;
      manager.releaseConversation(session);
    }
  });

  h.test('denied or canceled main-frame authorization never reaches the target server', async () => {
    const session = 'gate-errors';
    const page = await manager.createTab(session, `${base}/gate-errors`);
    const options = (manager as unknown as { options: { authorize?: (sessionId: string, url: string, resource: string, signal?: AbortSignal) => Promise<void> | void } }).options;
    const previous = options.authorize;
    let mode: 'deny' | 'cancel' = 'deny';
    options.authorize = async (_sessionId, url, _resource, signal) => {
      authorizationRequests.push({ sessionId: session, url, resource: 'browsing' });
      if (mode === 'deny') throw new Error('denied by policy');
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
      });
    };
    try {
      const finishDenied = manager.beginOperation(session, 'navigate');
      await manager.navigate(page, `${base}/deny-target`, { timeoutMs: 1000 }).catch(() => {});
      finishDenied();
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
      assertEqual(deniedTargetRequests, 0, 'denied request never reached the server');

      mode = 'cancel';
      const controller = new AbortController();
      const finishCanceled = manager.beginOperation(session, 'navigate', controller.signal);
      const before = authorizationRequests.length;
      const navigation = manager.navigate(page, `${base}/cancel-target`, { timeoutMs: 2000 }).catch(() => {});
      await waitFor(() => authorizationRequests.length > before && authorizationRequests.at(-1)?.url === `${base}/cancel-target`, 2000, 'cancel target started authorization');
      controller.abort();
      await navigation;
      finishCanceled();
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
      assertEqual(canceledTargetRequests, 0, 'canceled request never reached the server');
      assertEqual(canceledTargetRequests, 0, 'no late request is replayed after cancellation');
    } finally {
      options.authorize = previous;
      manager.releaseConversation(session);
    }
  });

  h.test('native slow download exposes pause, resume and completion without opening a real app', async () => {
    const session = 'slow-download';
    manager.releaseConversation(session);
    const page = await manager.createTab(session, `${base}/slow-source`);
    await page.cdp.evaluate("document.querySelector('#slow').click(); true");
    let row: BrowserObject | undefined;
    await waitFor(() => {
      row = (manager.downloadHistory({ query: 'slow.bin' }) as { items?: BrowserObject[] }).items?.find(item => item.filename === 'slow.bin');
      return !!row && row.canPause === true;
    }, 5000, 'slow download started');
    const id = String(row?.id);
    await assertRejects(() => manager.downloadAction('open', id), 'active download cannot open');
    assertDeepEqual(await manager.downloadAction('pause', id), { ok: true }, 'pause receipt');
    await waitFor(() => (manager.downloadHistory({ query: 'slow.bin' }) as { items?: BrowserObject[] }).items?.find(item => item.id === id)?.state === 'paused', 3000, 'paused state');
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
    assertDeepEqual(await manager.downloadAction('resume', id), { ok: true }, 'resume receipt');
    let completed: BrowserObject | undefined;
    await waitFor(() => {
      completed = (manager.downloadHistory({ query: 'slow.bin' }) as { items?: BrowserObject[] }).items?.find(item => item.id === id);
      return completed?.state === 'completed';
    }, 10_000, 'slow download completed');
    assertEqual(Number(completed?.receivedBytes), 64 * 1024 * 20, 'all bytes received');
    assertEqual(existsSync(String(completed?.path)), true, 'completed file exists');
    assertDeepEqual(await manager.downloadAction('open', id), { ok: true }, 'open completed file');
    assertDeepEqual(await manager.downloadAction('reveal', id), { ok: true }, 'reveal completed file');
    assertEqual(openedDownloads.at(-1), completed?.path, 'open spy receives the exact completed path');
    assertEqual(revealedDownloads.at(-1), completed?.path, 'reveal spy receives the exact completed path');
    manager.releaseConversation(session);
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
    enabled = false; manager.refreshPermissions(); manager.hide();
    try {
      assertEqual((await invoke('browser-use:show')).ok, true, 'manual presentation remains available with agent control off');
      const denied = await operations.execute('A', 'snapshot', { tabId: replacement.handle });
      assertEqual(object(denied.error).code, 'unavailable', 'agent control remains disabled');
    } finally { enabled = true; manager.refreshPermissions(); }
  });

  h.test('a page that destroys itself cannot poison later tab operations', async () => {
    manager.setConversation('A');
    const before = manager.listPages('A').length;
    const doomed = await manager.createTab('A', `${base}/doomed`);
    await manager.show({ sessionId: 'A' });
    // A page-initiated close (window.close(), an OAuth popup tearing itself
    // down) destroys the native page behind the manager's back. The manager
    // must retire the handle and keep later state and close calls safe.
    doomed.native.close();
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
    assertEqual(page.native.getURL(), `${base}/preview`, 'preview URL loaded in a real native page');
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

  h.test('clearing all data reloads open pages without recreating cleared history', async () => {
    const session = 'clear-all';
    const page = await manager.createTab(session, `${base}/clear-all`);
    await waitFor(() => (manager.history({ query: 'clear-all' }) as { items?: BrowserObject[] }).items?.length === 1, 5000, 'visit recorded before clearing');
    await manager.clearData('all');
    await waitFor(() => !page.native.getState().loading, 5000, 'page reload after clearing');
    await new Promise(resolveWait => setTimeout(resolveWait, 150));
    assertEqual((manager.history({ query: 'clear-all' }) as { items?: BrowserObject[] }).items?.length, 0, 'reload does not recreate cleared history');
    manager.releaseConversation(session);
  });

  h.test('shutdown closes all native pages and revokes the MCP endpoint', async () => {
    const pages = [...manager.listPages('A'), ...manager.listPages('B')];
    await mcp.shutdown();
    manager.dispose();
    await waitFor(() => pages.every(page => page.native.isDestroyed()), 5000, 'all native pages destroyed');
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
